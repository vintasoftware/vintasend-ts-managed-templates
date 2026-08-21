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
import {
  type ManagedTemplateStatus,
  type ManagedTemplateTagStatus,
  MOST_RECENT_ACTIVE_VERSION_STATUSES,
} from './constants.js';
import {
  ManagedTemplateInvalidTagError,
  ManagedTemplateNotFoundError,
  ManagedTemplateTagAlreadyExistsError,
  ManagedTemplateTagNotFoundError,
} from './errors.js';
import {
  type DateRange,
  type IntegerFieldFilter,
  isFieldFilter,
  isNumericFilterLookup,
  isStatusExactLookup,
  isStatusInLookup,
  isStringFilterLookup,
  type ManagedTemplateFilter,
  type ManagedTemplateFilterFields,
  type ManagedTemplateStatusFilter,
  type StringFieldFilter,
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

function matchesString(value: string, filter: StringFieldFilter): boolean {
  if (!isStringFilterLookup(filter)) {
    return value === filter;
  }

  const caseSensitive = filter.caseSensitive ?? true;
  const haystack = caseSensitive ? value : value.toLowerCase();
  const needle = caseSensitive ? filter.value : filter.value.toLowerCase();

  switch (filter.lookup) {
    case 'exact':
      return haystack === needle;
    case 'startsWith':
      return haystack.startsWith(needle);
    case 'endsWith':
      return haystack.endsWith(needle);
    case 'includes':
      return haystack.includes(needle);
  }
}

function matchesInteger(value: number, filter: IntegerFieldFilter): boolean {
  if (!isNumericFilterLookup(filter)) {
    return value === filter;
  }
  switch (filter.lookup) {
    case 'gt':
      return value > filter.value;
    case 'gte':
      return value >= filter.value;
    case 'lt':
      return value < filter.value;
    case 'lte':
      return value <= filter.value;
  }
}

function matchesStatus(value: ManagedTemplateStatus, filter: ManagedTemplateStatusFilter): boolean {
  if (isStatusInLookup(filter)) {
    return filter.value.includes(value);
  }
  if (isStatusExactLookup(filter)) {
    return value === filter.value;
  }
  return value === filter;
}

function matchesDateRange(value: Date, range: DateRange): boolean {
  if (range.from !== undefined && value.getTime() < range.from.getTime()) {
    return false;
  }
  if (range.to !== undefined && value.getTime() > range.to.getTime()) {
    return false;
  }
  return true;
}

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

  async getPaginatedTemplates(page: number, pageSize: number): Promise<ManagedTemplate[]> {
    return paginate(await this.getAllTemplates(), page, pageSize);
  }

  async getPaginatedFilteredTemplates(
    filters: ManagedTemplateFilter,
    page: number,
    pageSize: number,
  ): Promise<ManagedTemplate[]> {
    return paginate(await this.getFilteredTemplates(filters), page, pageSize);
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

  private matches(template: ManagedTemplate, filters: ManagedTemplateFilter): boolean {
    if (!isFieldFilter(filters)) {
      if ('and' in filters) {
        return filters.and.every((sub) => this.matches(template, sub));
      }
      if ('or' in filters) {
        return filters.or.some((sub) => this.matches(template, sub));
      }
      return !this.matches(template, filters.not);
    }
    return this.matchesFields(template, filters);
  }

  private matchesFields(template: ManagedTemplate, filters: ManagedTemplateFilterFields): boolean {
    if (filters.name !== undefined && !matchesString(template.name, filters.name)) {
      return false;
    }
    if (
      filters.description !== undefined &&
      !matchesString(template.description, filters.description)
    ) {
      return false;
    }
    if (filters.key !== undefined && !matchesString(template.key, filters.key)) {
      return false;
    }
    if (
      filters.templateManagedBackend !== undefined &&
      !matchesString(template.templateManagedBackend, filters.templateManagedBackend)
    ) {
      return false;
    }
    if (filters.version !== undefined && !matchesInteger(template.version, filters.version)) {
      return false;
    }
    if (filters.status !== undefined && !matchesStatus(template.status, filters.status)) {
      return false;
    }
    if (
      filters.createdAtRange !== undefined &&
      !matchesDateRange(template.createdAt, filters.createdAtRange)
    ) {
      return false;
    }
    if (
      filters.updatedAtRange !== undefined &&
      !matchesDateRange(template.updatedAt, filters.updatedAtRange)
    ) {
      return false;
    }
    if (filters.includesAllTags !== undefined) {
      const wanted = normalizeSlugs(filters.includesAllTags);
      const carried = new Set(template.tags.map((tag) => tag.slug));
      if (!wanted.every((slug) => carried.has(slug))) {
        return false;
      }
    }
    if (filters.includesAnyOfTags !== undefined) {
      const wanted = normalizeSlugs(filters.includesAnyOfTags);
      const carried = new Set(template.tags.map((tag) => tag.slug));
      if (!wanted.some((slug) => carried.has(slug))) {
        return false;
      }
    }
    if (filters.isAbstract !== undefined && template.isAbstract !== filters.isAbstract) {
      return false;
    }
    if (filters.mostRecentActiveVersion !== undefined) {
      if (this.isMostRecentActiveVersion(template) !== filters.mostRecentActiveVersion) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether this row is its key's current version.
   *
   * "This row is active or draft, and no active-or-draft row of the same key is numbered
   * higher" — the one filter answered against the key rather than the row.
   */
  private isMostRecentActiveVersion(template: ManagedTemplate): boolean {
    if (!MOST_RECENT_ACTIVE_VERSION_STATUSES.includes(template.status)) {
      return false;
    }
    return !this.versionsOf(template.key).some(
      (candidate) =>
        MOST_RECENT_ACTIVE_VERSION_STATUSES.includes(candidate.status) &&
        candidate.version > template.version,
    );
  }
}

function normalizeSlugs(tags: string[]): string[] {
  return tags.map((tag) => slugifyTag(tag)).filter(Boolean);
}

function paginate<Row>(rows: Row[], page: number, pageSize: number): Row[] {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
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
