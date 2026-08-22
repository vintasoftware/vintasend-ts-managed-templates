/**
 * Backend-agnostic service for managing template versions and their statuses.
 *
 * `ManagedTemplateService` sits between a host application and the two seams this package
 * defines: a `BaseTemplateManagerBackend` (where templates live) and a `ManagedTemplateRenderer`
 * (how a template turns into something an adapter can send). Every storage call goes through the
 * backend, so the service works unchanged against any implementation of that interface.
 *
 * What the service adds on top of the raw backend:
 *
 * * **Version resolution.** An absent `version` consistently means "the latest version of this
 *   key" across reads, status changes, and rendering, so callers never juggle version numbers
 *   unless they want a specific one.
 * * **Status transitions.** Status changes are validated against `allowedStatusTransitions` and
 *   then written through the backend's audit trail, with named helpers (`activate` /
 *   `deactivate` / `archive`) for the common moves.
 * * **Filter validation.** Filters are checked for shape and field names before they reach the
 *   backend, so a typo throws `ManagedTemplateInvalidFilterError` here instead of silently
 *   matching nothing (or blowing up) deep inside a backend's query translation.
 * * **Tag hygiene.** Tag text is normalized and slugified here before it reaches the backend, so
 *   every implementation of the storage seam is handed the same slug for the same text, and text
 *   with nothing sluggable in it is rejected with `ManagedTemplateInvalidTagError` instead of
 *   becoming a tag no filter can ever name.
 * * **Version-pinned rendering.** Rendering honours a notification's own
 *   `requestedTemplateVersion`, so a notification recorded against v3 renders v3 however many
 *   versions follow. The service adds an explicit `version` argument on top, overriding even
 *   that — which is what makes previewing an unpublished draft possible — and reports which
 *   version actually rendered, for the caller to record.
 * * **Composition.** Templates are flattened before they render: a template that extends a base
 *   or includes a fragment reaches the engine as one string with no `managed_*` tag left in it
 *   (see `composition`). Reads are unaffected — `getTemplate` still hands back exactly what is
 *   stored, and `getComposedTemplate` is the explicit way to ask for the assembled form.
 *
 * Two deliberate non-policies, both chosen so the service stays a thin orchestration layer:
 *
 * * A key may have **any number of active versions at once**. Activating a version does not touch
 *   the ones already active; deciding which active version wins at render time is the host's call.
 * * `changedBy` is **passed through untouched**, `null` included. The service never requires
 *   attribution on a status change.
 */

import type { AnyNotification, BaseNotificationTypeConfig, JsonObject } from 'vintasend';

import type { BaseTemplateManagerBackend } from './base-template-manager-backend.js';
import { TemplateComposer, type TemplateReference } from './composition.js';
import type { ManagedTemplateStatus, ManagedTemplateTagStatus } from './constants.js';
import {
  ManagedTemplateInvalidFilterError,
  ManagedTemplateInvalidTagError,
  ManagedTemplateStatusTransitionError,
  ManagedTemplateUnsupportedOrderingError,
} from './errors.js';
import {
  DEFAULT_TEMPLATE_BACKEND_FILTER_CAPABILITIES,
  FLAG_FILTER_FIELDS,
  isFieldFilter,
  isTagsFilter,
  KNOWN_FILTER_FIELDS,
  MANAGED_TEMPLATE_ORDER_BY_FIELDS,
  type ManagedTemplateFilter,
  type ManagedTemplateFilterCapabilities,
  type ManagedTemplateFilterFields,
  type ManagedTemplateOrderBy,
  type ManagedTemplateOrderByField,
  orderByCapabilityKey,
  TAG_FILTER_FIELDS,
} from './filters.js';
import type {
  ManagedTemplateRenderer,
  ManagedTemplateRenderResult,
} from './managed-template-renderer.js';
import { normalizeTagText, slugifyTag } from './tags.js';
import type {
  ManagedTemplate,
  ManagedTemplateCreateInput,
  ManagedTemplateStatusHistory,
  ManagedTemplateTag,
  ManagedTemplateUpdateInput,
} from './types.js';

/**
 * Which status a version may move to, keyed by the status it is in now.
 *
 * `archived` is terminal: an archived version is a historical record, and bringing one back would
 * make its audit trail read as though it had never been retired. Publish a new version instead.
 */
export const DEFAULT_STATUS_TRANSITIONS: Readonly<
  Record<ManagedTemplateStatus, readonly ManagedTemplateStatus[]>
> = {
  draft: ['active', 'archived'],
  active: ['inactive', 'archived'],
  inactive: ['active', 'archived'],
  archived: [],
};

export type ManagedTemplateServiceOptions = {
  /**
   * When true (the default), a status change must appear in `allowedStatusTransitions` for the
   * version's current status. Set false to let any status move to any other and leave the
   * ordering entirely to the host.
   */
  validateStatusTransitions?: boolean;
  /**
   * When true (the default), a template is flattened before it is rendered —
   * `{% managed_extends %}` / `{% managed_include %}` and the rest are resolved against this
   * service's backend. Set false to hand the engine what is stored, verbatim.
   */
  composeTemplates?: boolean;
  /**
   * The composer that does it. Defaults to one reading through the template manager backend, so
   * composition resolves against the same store the service reads from rather than through
   * whatever backend the renderer happens to hold.
   */
  composer?: TemplateComposer;
  /** A lifecycle other than the default one. */
  allowedStatusTransitions?: Readonly<
    Record<ManagedTemplateStatus, readonly ManagedTemplateStatus[]>
  >;
};

/**
 * The filter a listing applies unless it was asked for every version: one row per key.
 *
 * Built per call rather than shared, so a backend that keeps the filter it was handed — or a
 * caller that reads it off a fake and edits it — cannot change what the next listing means.
 */
function currentVersionsOnly(): ManagedTemplateFilterFields {
  return { mostRecentActiveVersion: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

export class ManagedTemplateService<
  Config extends BaseNotificationTypeConfig,
  RenderedType = unknown,
  ContentType = unknown,
> {
  readonly validateStatusTransitions: boolean;

  readonly composeTemplates: boolean;

  readonly composer: TemplateComposer;

  readonly allowedStatusTransitions: Readonly<
    Record<ManagedTemplateStatus, readonly ManagedTemplateStatus[]>
  >;

  private capabilitiesCache: ManagedTemplateFilterCapabilities | null = null;

  /**
   * @param templateManagerBackend where templates are stored and versioned.
   * @param templateRenderer turns a `ManagedTemplate` into something an adapter can send. The
   *   service drives its `createTemplateContent` / `renderFromTemplateContent` pair rather than
   *   its own backend read, so the renderer only needs to agree with this service on the shape of
   *   a template, not on where templates live.
   */
  constructor(
    readonly templateManagerBackend: BaseTemplateManagerBackend,
    readonly templateRenderer: ManagedTemplateRenderer<Config, RenderedType, ContentType>,
    options: ManagedTemplateServiceOptions = {},
  ) {
    this.validateStatusTransitions = options.validateStatusTransitions ?? true;
    this.composeTemplates = options.composeTemplates ?? true;
    this.composer = options.composer ?? TemplateComposer.fromBackend(templateManagerBackend);
    this.allowedStatusTransitions = options.allowedStatusTransitions ?? DEFAULT_STATUS_TRANSITIONS;
  }

  // -------------------------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------------------------

  /**
   * The backend's capability report, merged over the library default.
   *
   * Cached for the life of the service: a backend's capabilities are a static property of its
   * implementation, so re-asking on every request would buy nothing.
   */
  getBackendSupportedFilterCapabilities(): ManagedTemplateFilterCapabilities {
    if (this.capabilitiesCache === null) {
      const reported = this.templateManagerBackend.getFilterCapabilities?.() ?? {};
      this.capabilitiesCache = {
        ...DEFAULT_TEMPLATE_BACKEND_FILTER_CAPABILITIES,
        ...Object.fromEntries(
          Object.entries(reported).map(([key, value]) => [key, Boolean(value)]),
        ),
      };
    }
    return this.capabilitiesCache;
  }

  // -------------------------------------------------------------------------------------------
  // Versions
  // -------------------------------------------------------------------------------------------

  /**
   * Create the first version of a new template.
   *
   * Any tag text on the input that has no tag behind it yet becomes one, so a caller never has to
   * create tags before using them.
   *
   * @throws ManagedTemplateInvalidTagError if a tag text has nothing that can be slugified.
   */
  async createTemplate(input: ManagedTemplateCreateInput): Promise<ManagedTemplate> {
    return this.templateManagerBackend.createTemplate(this.withCleanTags(input));
  }

  /**
   * One version of a template. An absent `version` returns the latest version.
   *
   * @throws ManagedTemplateNotFoundError if the key (or that version of it) does not exist.
   */
  async getTemplate(templateKey: string, version: number | null = null): Promise<ManagedTemplate> {
    return this.templateManagerBackend.getTemplate(templateKey, version);
  }

  /**
   * Create a new version of an existing template from the latest one.
   *
   * Templates are versioned rather than edited in place, so this never mutates a version that has
   * already been published — the backend copies the latest version forward, applies the set
   * fields of `input`, and returns the new version.
   *
   * Tags follow the same rule as every other field on the input: absent carries the previous
   * version's tags forward, and an empty array means a version with none.
   */
  async updateTemplate(
    templateKey: string,
    input: ManagedTemplateUpdateInput,
  ): Promise<ManagedTemplate> {
    return this.templateManagerBackend.updateTemplate(templateKey, this.withCleanTags(input));
  }

  /**
   * Delete one version of a template, or its latest version when `version` is absent.
   */
  async deleteTemplate(templateKey: string, version: number | null = null): Promise<void> {
    await this.templateManagerBackend.deleteTemplate(templateKey, version);
  }

  /** Every version of a template, newest version first. */
  async getTemplateVersions(templateKey: string): Promise<ManagedTemplate[]> {
    const versions = await this.getFilteredTemplates({ key: templateKey });
    return [...versions].sort((left, right) => right.version - left.version);
  }

  private withCleanTags<InputType extends { tags?: string[] | null }>(input: InputType): InputType {
    if (input.tags === undefined || input.tags === null) {
      return input;
    }
    return { ...input, tags: this.cleanTagTexts(input.tags) };
  }

  // -------------------------------------------------------------------------------------------
  // Statuses
  // -------------------------------------------------------------------------------------------

  /**
   * Move one version of a template to `status` and record it in the audit trail.
   *
   * Setting a version to the status it already holds is a no-op: the template is returned
   * unchanged and no history entry is written, so repeating a call does not fill the audit trail
   * with entries that record nothing.
   *
   * @throws ManagedTemplateNotFoundError if the key (or that version of it) does not exist.
   * @throws ManagedTemplateStatusTransitionError if the move is not allowed from the version's
   *   current status and `validateStatusTransitions` is on.
   */
  async setStatus(
    templateKey: string,
    status: ManagedTemplateStatus,
    version: number | null = null,
    changedBy: string | null = null,
  ): Promise<ManagedTemplate> {
    const template = await this.getTemplate(templateKey, version);

    if (template.status === status) {
      return template;
    }

    this.checkStatusTransition(template, status);

    await this.templateManagerBackend.createTemplateStatusUpdate({
      templateKey,
      version: template.version,
      status,
      changedBy,
    });

    // The backend seam returns nothing from a status update, so re-read to hand back a template
    // whose status reflects the write rather than one captured before it.
    return this.getTemplate(templateKey, template.version);
  }

  /**
   * Publish one version of a template.
   *
   * Other versions of the same key that are already active are left alone — a key may hold
   * several active versions at once, and choosing between them is the host's call.
   */
  async activate(
    templateKey: string,
    version: number | null = null,
    changedBy: string | null = null,
  ): Promise<ManagedTemplate> {
    return this.setStatus(templateKey, 'active', version, changedBy);
  }

  /** Retire one version without archiving it, so it can be activated again. */
  async deactivate(
    templateKey: string,
    version: number | null = null,
    changedBy: string | null = null,
  ): Promise<ManagedTemplate> {
    return this.setStatus(templateKey, 'inactive', version, changedBy);
  }

  /** Archive one version. Terminal under the default transition table. */
  async archive(
    templateKey: string,
    version: number | null = null,
    changedBy: string | null = null,
  ): Promise<ManagedTemplate> {
    return this.setStatus(templateKey, 'archived', version, changedBy);
  }

  /**
   * The status audit trail for a template, most recent change first.
   *
   * @param version every version's history when absent, if the backend supports it.
   */
  async getStatusHistory(
    templateKey: string,
    version: number | null = null,
  ): Promise<ManagedTemplateStatusHistory[]> {
    const history = await this.templateManagerBackend.getTemplateStatusHistory(
      templateKey,
      version,
    );
    // Ties are broken by reversing the backend's own order rather than left to a stable sort.
    // Two changes to one version land in the same millisecond often enough to matter — a client
    // retrying, a migration replaying a trail — and a stable sort would leave the *older* of the
    // two first, which is the one thing "most recent first" must never do. Backends return a
    // trail oldest-first, so the later entry is the one further along the array.
    return history
      .map((record, index) => ({ record, index }))
      .sort(
        (left, right) =>
          right.record.createdAt.getTime() - left.record.createdAt.getTime() ||
          right.index - left.index,
      )
      .map(({ record }) => record);
  }

  /** Every template version in any of the given statuses. */
  async getTemplatesByStatus(status: ManagedTemplateStatus[]): Promise<ManagedTemplate[]> {
    return this.templateManagerBackend.getTemplatesByStatus(status);
  }

  /**
   * Whether `template` may move to `status`, without attempting the move.
   *
   * Lets a caller (a UI deciding which buttons to enable, say) ask the same question `setStatus`
   * asks, instead of catching the exception to find out.
   */
  canTransitionTo(template: ManagedTemplate, status: ManagedTemplateStatus): boolean {
    if (!this.validateStatusTransitions || template.status === status) {
      return true;
    }
    return (this.allowedStatusTransitions[template.status] ?? []).includes(status);
  }

  /**
   * Which statuses `template` may move to right now, in a stable order.
   *
   * The version's current status is excluded even though `canTransitionTo` returns true for it:
   * setting a version to the status it already holds is a documented no-op, not a transition, and
   * offering it as an action would be offering to do nothing.
   */
  allowedTransitionsFor(template: ManagedTemplate): ManagedTemplateStatus[] {
    return (['draft', 'active', 'inactive', 'archived'] as const).filter(
      (status) => status !== template.status && this.canTransitionTo(template, status),
    );
  }

  private checkStatusTransition(template: ManagedTemplate, status: ManagedTemplateStatus): void {
    if (this.canTransitionTo(template, status)) {
      return;
    }
    const allowed = [...(this.allowedStatusTransitions[template.status] ?? [])].sort();
    const allowedNames = allowed.length > 0 ? allowed.join(', ') : 'nothing';
    throw new ManagedTemplateStatusTransitionError(
      `Template '${template.key}' v${template.version} cannot move from ` +
        `'${template.status}' to '${status}'. Allowed: ${allowedNames}.`,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------------------------

  /**
   * Create a tag, failing if its text already slugs onto an existing one.
   *
   * Tagging a template creates missing tags on its own, so this is for the case where a tag is
   * being defined ahead of any template using it — and where a collision with an existing tag is
   * worth hearing about rather than silently resolving.
   */
  async createTag(text: string, tenant: string | null = null): Promise<ManagedTemplateTag> {
    return this.templateManagerBackend.createTag(this.cleanTagText(text), tenant);
  }

  /** One tag by slug, or by the text it was created from. */
  async getTag(slug: string): Promise<ManagedTemplateTag> {
    return this.templateManagerBackend.getTag(slug);
  }

  /** Tags, optionally narrowed by status, by a text search, or by tenant. */
  async getTags(
    status: ManagedTemplateTagStatus[] | null = null,
    search: string | null = null,
    tenant: string | null = null,
  ): Promise<ManagedTemplateTag[]> {
    return this.templateManagerBackend.getTags(status, search, tenant);
  }

  /** The tags still on offer — what a tag picker should show. */
  async getActiveTags(tenant: string | null = null): Promise<ManagedTemplateTag[]> {
    return this.getTags(['active'], null, tenant);
  }

  /**
   * Rename a tag, regenerating its slug from the new text.
   *
   * The templates carrying the tag keep it. The slug changes, though, so a saved filter naming
   * the old slug stops matching — a rename is a change of identity, not a display change.
   */
  async updateTag(slug: string, text: string): Promise<ManagedTemplateTag> {
    return this.templateManagerBackend.updateTag(slug, this.cleanTagText(text));
  }

  /** Retire a tag from the pickers without touching the templates carrying it. */
  async archiveTag(slug: string): Promise<ManagedTemplateTag> {
    return this.setTagStatus(slug, 'archived');
  }

  /**
   * Put an archived tag back on offer.
   *
   * Unlike an archived template version — terminal, because reviving one would rewrite what its
   * audit trail says happened — a tag carries no history to contradict, so archiving one is
   * reversible.
   */
  async restoreTag(slug: string): Promise<ManagedTemplateTag> {
    return this.setTagStatus(slug, 'active');
  }

  async setTagStatus(slug: string, status: ManagedTemplateTagStatus): Promise<ManagedTemplateTag> {
    return this.templateManagerBackend.setTagStatus(slug, status);
  }

  /** Delete a tag, removing it from every template carrying it. */
  async deleteTag(slug: string): Promise<void> {
    await this.templateManagerBackend.deleteTag(slug);
  }

  /** Resolve tag texts to tags, creating the ones that do not exist yet. */
  async getOrCreateTags(
    texts: string[],
    tenant: string | null = null,
  ): Promise<ManagedTemplateTag[]> {
    return this.templateManagerBackend.getOrCreateTags(this.cleanTagTexts(texts), tenant);
  }

  /** The tags on one version of a template, or on its latest version. */
  async getTemplateTags(
    templateKey: string,
    version: number | null = null,
  ): Promise<ManagedTemplateTag[]> {
    return this.templateManagerBackend.getTemplateTags(templateKey, version);
  }

  /**
   * Replace the tags on one version of a template, creating any that do not exist.
   *
   * Retagging edits the version in place instead of creating a new one: tags are how a template
   * is found, not part of what it renders, so relabelling should not spawn a version and drop it
   * back to `draft`.
   */
  async setTemplateTags(
    templateKey: string,
    tags: string[],
    version: number | null = null,
  ): Promise<ManagedTemplate> {
    return this.templateManagerBackend.setTemplateTags(
      templateKey,
      this.cleanTagTexts(tags),
      version,
    );
  }

  /** Add tags to a version, leaving the ones already on it in place. */
  async addTemplateTags(
    templateKey: string,
    tags: string[],
    version: number | null = null,
  ): Promise<ManagedTemplate> {
    const template = await this.getTemplate(templateKey, version);
    const existing = template.tags.map((tag) => tag.slug);
    const added = ManagedTemplateService.slugsFor(tags).filter((slug) => !existing.includes(slug));
    if (added.length === 0) {
      return template;
    }
    return this.setTemplateTags(templateKey, [...existing, ...added], template.version);
  }

  /**
   * Remove tags from a version. Tags it does not carry are ignored.
   *
   * The tags themselves survive — this unlinks them from one version, it does not delete them.
   */
  async removeTemplateTags(
    templateKey: string,
    tags: string[],
    version: number | null = null,
  ): Promise<ManagedTemplate> {
    const template = await this.getTemplate(templateKey, version);
    const unwanted = new Set(ManagedTemplateService.slugsFor(tags));
    const remaining = template.tags.map((tag) => tag.slug).filter((slug) => !unwanted.has(slug));
    if (remaining.length === template.tags.length) {
      return template;
    }
    return this.setTemplateTags(templateKey, remaining, template.version);
  }

  /**
   * The templates carrying these tags — all of them, or any of them.
   *
   * A shorthand for the `includesAllTags` / `includesAnyOfTags` filters, which is what it builds.
   * Follows the same empty-collection rule they do: matching *all* of no tags returns everything,
   * matching *any* of no tags returns nothing.
   */
  async getTemplatesByTags(tags: string[], matchAll = true): Promise<ManagedTemplate[]> {
    const slugs = ManagedTemplateService.slugsFor(tags);
    return this.getFilteredTemplates(
      matchAll ? { includesAllTags: slugs } : { includesAnyOfTags: slugs },
    );
  }

  /**
   * Trim a tag's text, rejecting it when nothing sluggable is left.
   *
   * Checked here rather than left to the backend so every backend is handed text it can slugify,
   * and so a caller hears about `'  '` or `'!!!'` at the call site instead of ending up with a
   * tag whose slug is empty and which no filter can name.
   */
  private cleanTagText(text: string): string {
    const cleaned = normalizeTagText(text);
    if (!cleaned || !slugifyTag(cleaned)) {
      throw new ManagedTemplateInvalidTagError(
        `Tag text ${JSON.stringify(text)} has no characters that can be turned into a slug.`,
      );
    }
    return cleaned;
  }

  /** Clean each text, dropping repeats that slug onto a tag already in the list. */
  private cleanTagTexts(texts: string[]): string[] {
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const text of texts) {
      const candidate = this.cleanTagText(text);
      const slug = slugifyTag(candidate);
      if (seen.has(slug)) {
        continue;
      }
      seen.add(slug);
      cleaned.push(candidate);
    }
    return cleaned;
  }

  /**
   * Slugify a caller's tag texts, dropping the ones with nothing sluggable.
   *
   * Unlike `cleanTagTexts` this never throws: these slugs are used to *match*, and a tag no store
   * could hold simply matches nothing — which is a correct answer, not an error worth
   * interrupting a search for.
   */
  private static slugsFor(tags: string[]): string[] {
    const slugs: string[] = [];
    for (const tag of tags) {
      const slug = slugifyTag(tag);
      if (slug && !slugs.includes(slug)) {
        slugs.push(slug);
      }
    }
    return slugs;
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  /**
   * The current version of every template — one row per key.
   *
   * "Current" is the `mostRecentActiveVersion` filter: the highest-numbered active or draft
   * version of each key. It is the default because a listing is nearly always a list of
   * *templates*, and the store holds a row per *version*, so the unfiltered read shows the same
   * template once per version it has ever had and hides the current one among its own history.
   *
   * Pass `includeAllVersions: true` for the raw read.
   */
  async getAllTemplates(includeAllVersions = false): Promise<ManagedTemplate[]> {
    if (includeAllVersions) {
      return this.templateManagerBackend.getAllTemplates();
    }
    return this.getFilteredTemplates(currentVersionsOnly());
  }

  /**
   * The templates matching `filters`.
   *
   * @throws ManagedTemplateInvalidFilterError if the filter is malformed or names an unknown
   *   field.
   */
  async getFilteredTemplates(filters: ManagedTemplateFilter): Promise<ManagedTemplate[]> {
    this.validateFilter(filters);
    return this.templateManagerBackend.getFilteredTemplates(filters);
  }

  /**
   * One page of templates, one row per key by default.
   *
   * @param page 1-indexed.
   */
  async getPaginatedTemplates(
    page: number,
    pageSize: number,
    includeAllVersions = false,
    orderBy?: ManagedTemplateOrderBy,
  ): Promise<ManagedTemplate[]> {
    ManagedTemplateService.validatePagination(page, pageSize);
    this.validateOrderBy(orderBy);
    if (includeAllVersions) {
      return this.templateManagerBackend.getPaginatedTemplates(page, pageSize, orderBy);
    }
    return this.getPaginatedFilteredTemplates(currentVersionsOnly(), page, pageSize, orderBy);
  }

  /**
   * One page of the templates matching `filters`.
   *
   * @param page 1-indexed.
   */
  async getPaginatedFilteredTemplates(
    filters: ManagedTemplateFilter,
    page: number,
    pageSize: number,
    orderBy?: ManagedTemplateOrderBy,
  ): Promise<ManagedTemplate[]> {
    this.validateFilter(filters);
    ManagedTemplateService.validatePagination(page, pageSize);
    this.validateOrderBy(orderBy);
    return this.templateManagerBackend.getPaginatedFilteredTemplates(
      filters,
      page,
      pageSize,
      orderBy,
    );
  }

  /**
   * Refuse an order the backend cannot apply, rather than passing it on to be ignored.
   *
   * Unlike an unsupported filter — which a caller drops, getting more rows than it asked for and
   * being able to tell — an ignored order returns exactly the rows requested in an arbitrary
   * sequence. Nothing downstream can detect that, so the only honest options are to apply it or
   * to refuse, and the backend has already said which one this is.
   */
  validateOrderBy(orderBy: ManagedTemplateOrderBy | undefined): void {
    if (orderBy === undefined) {
      return;
    }
    if (!MANAGED_TEMPLATE_ORDER_BY_FIELDS.includes(orderBy.field)) {
      throw new ManagedTemplateUnsupportedOrderingError(
        `'${orderBy.field}' is not an orderable field. Order by one of: ` +
          `${MANAGED_TEMPLATE_ORDER_BY_FIELDS.join(', ')}.`,
      );
    }
    if (orderBy.direction !== 'asc' && orderBy.direction !== 'desc') {
      throw new ManagedTemplateUnsupportedOrderingError(
        `'${orderBy.direction}' is not a sort direction. Use 'asc' or 'desc'.`,
      );
    }

    const key = orderByCapabilityKey(orderBy.field);
    if (!this.getBackendSupportedFilterCapabilities()[key]) {
      throw new ManagedTemplateUnsupportedOrderingError(
        `The configured template backend cannot order by '${orderBy.field}' ` +
          `(${key} is false). Read getBackendSupportedFilterCapabilities() and offer only the ` +
          'fields it reports.',
      );
    }
  }

  /** Every field this backend can order a listing by, in vocabulary order. */
  getSupportedOrderByFields(): ManagedTemplateOrderByField[] {
    const capabilities = this.getBackendSupportedFilterCapabilities();
    return MANAGED_TEMPLATE_ORDER_BY_FIELDS.filter(
      (field) => capabilities[orderByCapabilityKey(field)] === true,
    );
  }

  /**
   * Check a filter's shape and field names, throwing rather than passing a broken filter on.
   *
   * A backend translating an unknown field usually either matches nothing or throws something
   * backend-specific, both of which are hard to debug from the call site. This catches the common
   * mistakes — a typo'd field name, an `and`/`or` that is not an array, a logical group carrying
   * sibling keys — while the caller's own frame is still on the stack. It does not validate
   * lookup values; the backend remains the authority there.
   *
   * @throws ManagedTemplateInvalidFilterError if the filter is malformed or names an unknown
   *   field.
   */
  validateFilter(filters: ManagedTemplateFilter, path = 'filters'): void {
    if (!isRecord(filters)) {
      throw new ManagedTemplateInvalidFilterError(
        `${path} must be an object, got ${describeType(filters)}.`,
      );
    }

    if (isFieldFilter(filters)) {
      const known = new Set<string>(KNOWN_FILTER_FIELDS);
      const unknown = Object.keys(filters)
        .filter((key) => !known.has(key))
        .sort();
      if (unknown.length > 0) {
        throw new ManagedTemplateInvalidFilterError(
          `${path} names unknown field(s): ${unknown.join(', ')}. ` +
            `Known fields: ${[...KNOWN_FILTER_FIELDS].sort().join(', ')}.`,
        );
      }
      this.validateTagFields(filters, path);
      this.validateFlagFields(filters, path);
      return;
    }

    // A logical group is exactly one of and/or/not, and nothing else. Allowing siblings would
    // make the intended combination ambiguous.
    const keys = Object.keys(filters);
    if (keys.length > 1) {
      throw new ManagedTemplateInvalidFilterError(
        `${path} mixes a logical operator with other keys (${[...keys].sort().join(', ')}). ` +
          'Wrap the field filter in its own group instead.',
      );
    }

    const key = keys[0] as 'and' | 'or' | 'not';
    const value = (filters as Record<string, unknown>)[key];

    if (key === 'not') {
      this.validateFilter(value as ManagedTemplateFilter, `${path}.not`);
      return;
    }

    if (!Array.isArray(value)) {
      throw new ManagedTemplateInvalidFilterError(
        `${path}.${key} must be an array of filters, got ${describeType(value)}.`,
      );
    }
    if (value.length === 0) {
      throw new ManagedTemplateInvalidFilterError(`${path}.${key} must not be empty.`);
    }
    value.forEach((subFilter, index) => {
      this.validateFilter(subFilter as ManagedTemplateFilter, `${path}.${key}[${index}]`);
    });
  }

  /**
   * Reject a tag filter that is not an array of strings.
   *
   * One of the two value checks `validateFilter` does make, because the failure it prevents is
   * silent rather than loud: a bare `'welcome'` would have a backend ask for the tags `w`, `e`,
   * `l`, `c` and return nothing, with no error anywhere.
   */
  private validateTagFields(filters: ManagedTemplateFilterFields, path: string): void {
    for (const field of TAG_FILTER_FIELDS) {
      const value = filters[field];
      if (value === undefined) {
        continue;
      }
      if (!isTagsFilter(value)) {
        throw new ManagedTemplateInvalidFilterError(
          `${path}.${field} must be an array of tag slugs, got ${describeType(value)}. ` +
            'Wrap a single tag in an array.',
        );
      }
    }
  }

  /**
   * Reject a flag filter whose value is not a boolean.
   *
   * Checked for the same reason the tag fields are: the failure is silent otherwise. A backend
   * reads a flag for its truthiness, so the string `'false'` — what a query parameter that
   * skipped parsing arrives as — would ask for exactly what the caller meant to switch off.
   */
  private validateFlagFields(filters: ManagedTemplateFilterFields, path: string): void {
    for (const field of FLAG_FILTER_FIELDS) {
      const value = filters[field];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'boolean') {
        throw new ManagedTemplateInvalidFilterError(
          `${path}.${field} must be a boolean, got ${describeType(value)}.`,
        );
      }
    }
  }

  private static validatePagination(page: number, pageSize: number): void {
    if (!Number.isInteger(page) || page < 1) {
      throw new RangeError(`page must be an integer of 1 or greater, got ${page}.`);
    }
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new RangeError(`pageSize must be an integer of 1 or greater, got ${pageSize}.`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Composition
  // -------------------------------------------------------------------------------------------

  /**
   * Flatten a template's inheritance and inclusion into a single self-contained one.
   *
   * Composition is what a store-backed template has instead of an engine loader: the engine is
   * handed source rather than a name, so a `{% managed_extends %}` here is resolved against the
   * backend before the engine ever sees the template. The result has no `managed_*` tag left in
   * it, and the engine's own syntax is untouched.
   *
   * A no-op — returning the very template it was given — when the template composes to itself,
   * and when the service was built with `composeTemplates: false`.
   */
  async composeTemplate(template: ManagedTemplate): Promise<ManagedTemplate> {
    if (!this.composeTemplates) {
      return template;
    }
    return this.composer.compose(template);
  }

  /**
   * One version of a template, assembled as the engine will receive it.
   *
   * The counterpart to `getTemplate`, which is deliberately literal about what is stored.
   */
  async getComposedTemplate(
    templateKey: string,
    version: number | null = null,
  ): Promise<ManagedTemplate> {
    return this.composeTemplate(await this.getTemplate(templateKey, version));
  }

  /**
   * Assemble a template and throw the result away, to surface any problem now.
   *
   * What a form or a deploy check calls: it throws exactly what rendering would have thrown — a
   * malformed tag, a base that does not exist, a loop — at a point where someone can still fix it
   * rather than at send time.
   */
  async validateComposition(template: ManagedTemplate): Promise<void> {
    await this.composer.validate(template);
  }

  /**
   * The templates one template directly extends or includes.
   *
   * Direct references only, and nothing is resolved, so this answers "what does this template
   * name" without needing any of them to exist.
   */
  getTemplateReferences(template: ManagedTemplate): TemplateReference[] {
    return this.composer.references(template);
  }

  /**
   * Whether a template is a base to build on rather than one to send.
   *
   * Read off the source every time it is asked, which makes it the authority:
   * `template.isAbstract` is a backend's stored copy of this answer, kept for the `isAbstract`
   * filter to query, and this is what that copy is supposed to say.
   *
   * To *find* the bases rather than test one, filter on the stored flag — it is indexed and this
   * is not:
   *
   * ```ts
   * await service.getFilteredTemplates({ isAbstract: false }); // everything sendable
   * ```
   *
   * Neither one refuses anything: the service renders an abstract template quite happily, and
   * gives you the layout with an empty hole. Keeping bases out of a picker is the host's call.
   */
  isAbstract(template: ManagedTemplate): boolean {
    return this.composer.isAbstract(template);
  }

  // -------------------------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------------------------

  /**
   * Render a notification against a specific version of its template.
   *
   * The notification's `bodyTemplate` is the template key. Which version renders is decided in
   * this order: the `version` argument, then the notification's own `requestedTemplateVersion`,
   * then whatever the backend considers current.
   *
   * The argument is there to render a version the notification is *not* pinned to — previewing an
   * unpublished draft, or reproducing what an old notification looked like. Leave it off and this
   * renders what a real send would.
   */
  async render(
    notification: AnyNotification<Config>,
    context: JsonObject,
    version: number | null = null,
  ): Promise<ManagedTemplateRenderResult<RenderedType>> {
    return this.templateRenderer.renderManaged(notification, context, version);
  }

  /**
   * Render a notification against a template already in hand, with no backend read.
   *
   * The template is composed by this service — through *its* composer and *its*
   * `composeTemplates` setting, not the renderer's — so one already fetched and edited in memory
   * renders the same way a stored one does.
   */
  async renderTemplate(
    notification: AnyNotification<Config>,
    template: ManagedTemplate,
    context: JsonObject,
  ): Promise<ManagedTemplateRenderResult<RenderedType>> {
    const composed = await this.composeTemplate(template);
    const content = this.templateRenderer.createTemplateContent(composed);
    const rendered = await this.templateRenderer.renderFromTemplateContent(
      notification,
      content,
      context,
    );
    return { key: template.key, version: template.version, rendered };
  }
}
