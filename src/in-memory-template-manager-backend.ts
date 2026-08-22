/**
 * A complete `BaseTemplateManagerBackend` that keeps everything in process memory.
 *
 * Two jobs. It is what a test suite — this package's, a renderer's, an API's — runs against
 * without standing up a database. And it is the executable statement of what the seam means:
 * every rule the interface documents in prose (a new version starts in `draft`, retagging edits
 * in place, `mostRecentActiveVersion` is answered against the key rather than the row) is code
 * here, so a backend author has something to compare behaviour against rather than only prose.
 *
 * Not for production: nothing is persisted, nothing is locked, and every filter is evaluated by
 * scanning the whole store.
 */

import type { BaseTemplateManagerBackend } from './base-template-manager-backend.js';
import { isAbstract } from './composition.js';
import type { ManagedTemplateStatus, ManagedTemplateTagStatus } from './constants.js';
import {
  ManagedTemplateInvalidTagError,
  ManagedTemplateNotFoundError,
  ManagedTemplateTagAlreadyExistsError,
  ManagedTemplateTagNotFoundError,
} from './errors.js';
import { matchesTemplateFilter, paginate, sortTemplates } from './filter-evaluation.js';
import {
  MANAGED_TEMPLATE_ORDER_BY_FIELDS,
  type ManagedTemplateFilter,
  type ManagedTemplateFilterCapabilities,
  type ManagedTemplateOrderBy,
  orderByCapabilityKey,
} from './filters.js';
import { nextAvailableSlug, normalizeTagText, slugifyTag } from './tags.js';
import type {
  ManagedTemplate,
  ManagedTemplateCreateInput,
  ManagedTemplateStatusHistory,
  ManagedTemplateTag,
  ManagedTemplateUpdateInput,
} from './types.js';

export type InMemoryTemplateManagerBackendOptions = {
  /** Overridden in tests so timestamps are deterministic. */
  now?: () => Date;
};

export class InMemoryTemplateManagerBackend implements BaseTemplateManagerBackend {
  private templates: ManagedTemplate[] = [];

  private tags: ManagedTemplateTag[] = [];

  private history: ManagedTemplateStatusHistory[] = [];

  private nextId = 1;

  private readonly now: () => Date;

  constructor(options: InMemoryTemplateManagerBackendOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------------------------

  async createTemplate(data: ManagedTemplateCreateInput): Promise<ManagedTemplate> {
    const timestamp = this.now();
    const template: ManagedTemplate = {
      id: this.nextId++,
      key: data.key,
      version: 1,
      name: data.name,
      description: data.description,
      templateManagedBackend: data.templateManagedBackend,
      bodyTemplate: data.bodyTemplate,
      subjectTemplate: data.subjectTemplate,
      preheaderTemplate: data.preheaderTemplate,
      status: 'draft',
      tenant: data.tenant,
      createdAt: timestamp,
      updatedAt: timestamp,
      tags: await this.resolveTags(data.tags ?? [], data.tenant),
      isAbstract: this.deriveIsAbstract(data),
    };
    this.templates.push(template);
    return structuredCloneTemplate(template);
  }

  async getTemplate(templateKey: string, version: number | null = null): Promise<ManagedTemplate> {
    const template = this.find(templateKey, version);
    if (template === undefined) {
      throw new ManagedTemplateNotFoundError(describeMissing(templateKey, version));
    }
    return structuredCloneTemplate(template);
  }

  async updateTemplate(
    templateKey: string,
    data: ManagedTemplateUpdateInput,
  ): Promise<ManagedTemplate> {
    const previous = this.find(templateKey, null);
    if (previous === undefined) {
      throw new ManagedTemplateNotFoundError(describeMissing(templateKey, null));
    }

    // Resolved before the insert so an unusable tag text fails the whole update rather than
    // leaving a new version behind with the wrong labels.
    const tags =
      data.tags === undefined || data.tags === null
        ? previous.tags
        : await this.resolveTags(data.tags, previous.tenant);

    const timestamp = this.now();
    const sources = {
      bodyTemplate: data.bodyTemplate || previous.bodyTemplate,
      subjectTemplate: data.subjectTemplate ?? previous.subjectTemplate,
      preheaderTemplate: data.preheaderTemplate ?? previous.preheaderTemplate,
    };
    const template: ManagedTemplate = {
      id: this.nextId++,
      key: previous.key,
      version: previous.version + 1,
      name: data.name || previous.name,
      description: data.description ?? previous.description,
      templateManagedBackend: previous.templateManagedBackend,
      ...sources,
      // A copy nobody has reviewed should not inherit "published".
      status: 'draft',
      tenant: previous.tenant,
      createdAt: timestamp,
      updatedAt: timestamp,
      tags,
      isAbstract: this.deriveIsAbstract(sources),
    };
    this.templates.push(template);
    return structuredCloneTemplate(template);
  }

  async deleteTemplate(templateKey: string, version: number | null = null): Promise<void> {
    const template = this.find(templateKey, version);
    if (template === undefined) {
      throw new ManagedTemplateNotFoundError(describeMissing(templateKey, version));
    }
    this.templates = this.templates.filter((candidate) => candidate !== template);
  }

  async createTemplateStatusUpdate(params: {
    templateKey: string;
    version: number;
    status: ManagedTemplateStatus;
    changedBy?: string | null;
  }): Promise<void> {
    const template = this.find(params.templateKey, params.version);
    if (template === undefined) {
      throw new ManagedTemplateNotFoundError(describeMissing(params.templateKey, params.version));
    }
    template.status = params.status;
    template.updatedAt = this.now();
    this.history.push({
      templateKey: params.templateKey,
      version: params.version,
      status: params.status,
      createdAt: this.now(),
      changedBy: params.changedBy ?? null,
      tenant: template.tenant,
    });
  }

  async getTemplateStatusHistory(
    templateKey: string,
    version: number | null = null,
  ): Promise<ManagedTemplateStatusHistory[]> {
    if (this.versionsOf(templateKey).length === 0) {
      throw new ManagedTemplateNotFoundError(describeMissing(templateKey, null));
    }
    return this.history
      .filter(
        (record) =>
          record.templateKey === templateKey && (version === null || record.version === version),
      )
      .map((record) => ({ ...record }));
  }

  // -------------------------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------------------------

  async getOrCreateTags(
    texts: string[],
    tenant: string | null = null,
  ): Promise<ManagedTemplateTag[]> {
    return this.resolveTags(texts, tenant);
  }

  async createTag(text: string, tenant: string | null = null): Promise<ManagedTemplateTag> {
    const cleaned = this.cleanText(text);
    const slug = slugifyTag(cleaned);
    if (this.tags.some((tag) => tag.slug === slug)) {
      throw new ManagedTemplateTagAlreadyExistsError(`A tag with slug '${slug}' already exists.`);
    }
    return { ...(await this.insertTag(cleaned, tenant)) };
  }

  async getTag(slug: string): Promise<ManagedTemplateTag> {
    return { ...this.requireTag(slug) };
  }

  async updateTag(slug: string, text: string): Promise<ManagedTemplateTag> {
    const tag = this.requireTag(slug);
    const cleaned = this.cleanText(text);
    const base = slugifyTag(cleaned);
    tag.text = cleaned;
    tag.slug = await nextAvailableSlug(base, (candidate) =>
      this.tags.some((other) => other !== tag && other.slug === candidate),
    );
    tag.updatedAt = this.now();
    this.syncTagOnTemplates(tag);
    return { ...tag };
  }

  async setTagStatus(slug: string, status: ManagedTemplateTagStatus): Promise<ManagedTemplateTag> {
    const tag = this.requireTag(slug);
    tag.status = status;
    tag.updatedAt = this.now();
    this.syncTagOnTemplates(tag);
    return { ...tag };
  }

  async deleteTag(slug: string): Promise<void> {
    const tag = this.requireTag(slug);
    this.tags = this.tags.filter((candidate) => candidate !== tag);
    for (const template of this.templates) {
      template.tags = template.tags.filter((candidate) => candidate.id !== tag.id);
    }
  }

  async getTags(
    status: ManagedTemplateTagStatus[] | null = null,
    search: string | null = null,
    tenant: string | null = null,
  ): Promise<ManagedTemplateTag[]> {
    const term = search === null ? null : search.toLowerCase();
    return this.tags
      .filter((tag) => status === null || status.includes(tag.status))
      .filter((tag) => tenant === null || tag.tenant === tenant)
      .filter(
        (tag) =>
          term === null ||
          tag.text.toLowerCase().includes(term) ||
          tag.slug.toLowerCase().includes(term),
      )
      .map((tag) => ({ ...tag }));
  }

  async getTemplateTags(
    templateKey: string,
    version: number | null = null,
  ): Promise<ManagedTemplateTag[]> {
    const template = this.find(templateKey, version);
    if (template === undefined) {
      throw new ManagedTemplateNotFoundError(describeMissing(templateKey, version));
    }
    return template.tags.map((tag) => ({ ...tag }));
  }

  async setTemplateTags(
    templateKey: string,
    tags: string[],
    version: number | null = null,
  ): Promise<ManagedTemplate> {
    const template = this.find(templateKey, version);
    if (template === undefined) {
      throw new ManagedTemplateNotFoundError(describeMissing(templateKey, version));
    }
    template.tags = await this.resolveTags(tags, template.tenant);
    template.updatedAt = this.now();
    return structuredCloneTemplate(template);
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  async getAllTemplates(): Promise<ManagedTemplate[]> {
    return this.templates.map(structuredCloneTemplate);
  }

  async getTemplatesByStatus(status: ManagedTemplateStatus[]): Promise<ManagedTemplate[]> {
    return this.templates
      .filter((template) => status.includes(template.status))
      .map(structuredCloneTemplate);
  }

  async getFilteredTemplates(filters: ManagedTemplateFilter): Promise<ManagedTemplate[]> {
    return this.templates
      .filter((template) => this.matches(template, filters))
      .map(structuredCloneTemplate);
  }

  /**
   * Everything, including every order.
   *
   * This backend holds the whole store in memory, so it can sort a complete result set before
   * paging it — which is what ordering requires. It therefore declares the `orderBy.*` keys
   * explicitly: they default to false, and a backend that can genuinely do it has to say so.
   */
  getFilterCapabilities(): ManagedTemplateFilterCapabilities {
    return Object.fromEntries(
      MANAGED_TEMPLATE_ORDER_BY_FIELDS.map((field) => [orderByCapabilityKey(field), true]),
    );
  }

  async getPaginatedTemplates(
    page: number,
    pageSize: number,
    orderBy?: ManagedTemplateOrderBy,
  ): Promise<ManagedTemplate[]> {
    return paginate(sortTemplates(await this.getAllTemplates(), orderBy), page, pageSize);
  }

  async getPaginatedFilteredTemplates(
    filters: ManagedTemplateFilter,
    page: number,
    pageSize: number,
    orderBy?: ManagedTemplateOrderBy,
  ): Promise<ManagedTemplate[]> {
    // Sorted before paging, never after: the page has to be chosen from an ordered set.
    return paginate(
      sortTemplates(await this.getFilteredTemplates(filters), orderBy),
      page,
      pageSize,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private deriveIsAbstract(sources: {
    bodyTemplate: string;
    subjectTemplate: string | null;
    preheaderTemplate: string | null;
  }): boolean {
    try {
      return isAbstract(sources);
    } catch {
      // A source nobody can parse has no answer. Storing `false` keeps the syntax error out of
      // the write, where the edit boundary has already had its chance to refuse it.
      return false;
    }
  }

  private versionsOf(templateKey: string): ManagedTemplate[] {
    return this.templates.filter((template) => template.key === templateKey);
  }

  private find(templateKey: string, version: number | null): ManagedTemplate | undefined {
    const versions = this.versionsOf(templateKey);
    if (version !== null) {
      return versions.find((template) => template.version === version);
    }
    return versions.reduce<ManagedTemplate | undefined>(
      (latest, template) =>
        latest === undefined || template.version > latest.version ? template : latest,
      undefined,
    );
  }

  private requireTag(slug: string): ManagedTemplateTag {
    const normalized = slugifyTag(slug);
    const tag = this.tags.find((candidate) => candidate.slug === normalized);
    if (tag === undefined) {
      throw new ManagedTemplateTagNotFoundError(`No tag with slug '${slug}' was found.`);
    }
    return tag;
  }

  private cleanText(text: string): string {
    const cleaned = normalizeTagText(text);
    if (!cleaned || !slugifyTag(cleaned)) {
      throw new ManagedTemplateInvalidTagError(
        `Tag text ${JSON.stringify(text)} has no characters that can be turned into a slug.`,
      );
    }
    return cleaned;
  }

  private async insertTag(text: string, tenant: string | null): Promise<ManagedTemplateTag> {
    const timestamp = this.now();
    const slug = await nextAvailableSlug(slugifyTag(text), (candidate) =>
      this.tags.some((tag) => tag.slug === candidate),
    );
    const tag: ManagedTemplateTag = {
      id: this.nextId++,
      text,
      slug,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      tenant,
    };
    this.tags.push(tag);
    return tag;
  }

  /**
   * Resolve texts to tags, creating what is missing — one tag per distinct text, in order.
   *
   * An existing tag is returned as it stands: its text and status are left alone, so re-using an
   * archived tag does not quietly bring it back.
   */
  private async resolveTags(texts: string[], tenant: string | null): Promise<ManagedTemplateTag[]> {
    const resolved: ManagedTemplateTag[] = [];
    for (const text of texts) {
      const cleaned = this.cleanText(text);
      const slug = slugifyTag(cleaned);
      if (resolved.some((tag) => tag.slug === slug)) {
        continue;
      }
      const existing = this.tags.find((tag) => tag.slug === slug);
      resolved.push(existing ?? (await this.insertTag(cleaned, tenant)));
    }
    return resolved;
  }

  /** Keep the copies embedded on template rows in step with the tag record itself. */
  private syncTagOnTemplates(tag: ManagedTemplateTag): void {
    for (const template of this.templates) {
      template.tags = template.tags.map((candidate) => (candidate.id === tag.id ? tag : candidate));
    }
  }

  /**
   * Evaluate a filter over the whole store.
   *
   * The semantics live in `filter-evaluation`, shared with every backend that has to finish a
   * filter its query language could not express — so this store and a FHIR one agree on what
   * `includesAllTags: []` means without either of them re-deriving it.
   */
  private matches(template: ManagedTemplate, filters: ManagedTemplateFilter): boolean {
    return matchesTemplateFilter(template, filters, {
      versionsOfKey: (key) => this.versionsOf(key),
    });
  }
}

function structuredCloneTemplate(template: ManagedTemplate): ManagedTemplate {
  return { ...template, tags: template.tags.map((tag) => ({ ...tag })) };
}

function describeMissing(templateKey: string, version: number | null): string {
  if (version === null) {
    return `No template with key '${templateKey}' was found.`;
  }
  return `Template '${templateKey}' has no version ${version}.`;
}
