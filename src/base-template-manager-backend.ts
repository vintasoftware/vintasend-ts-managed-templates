import type { ManagedTemplateStatus, ManagedTemplateTagStatus } from './constants.js';
import type {
  ManagedTemplateFilter,
  ManagedTemplateFilterCapabilities,
  ManagedTemplateOrderBy,
} from './filters.js';
import type {
  ManagedTemplate,
  ManagedTemplateCreateInput,
  ManagedTemplateStatusHistory,
  ManagedTemplateTag,
  ManagedTemplateUpdateInput,
} from './types.js';

/**
 * Where managed templates are stored, versioned, tagged and queried.
 *
 * One responsibility here is easy to miss because no method is named for it:
 * **`ManagedTemplate.isAbstract` is the backend's to derive.** It is denormalized from the
 * template's own source — `composition.isAbstract` computes it — and neither write input carries
 * it, because it is a fact about the source rather than something a caller decides. Derive it on
 * every write that touches a source field and store the answer, so the `isAbstract` filter can
 * be a field lookup instead of a full-store parse. A backend that never sets it reports every
 * template as concrete, and that filter quietly stops working.
 *
 * A source whose composition tags are malformed has no answer: store `false` rather than letting
 * the syntax error out of the write. The flag is a search convenience, a template nobody can
 * parse cannot be extended either, and a write is the wrong place to report a syntax error — the
 * edit boundary already refuses it, and `compose` reports it in full at the point where it
 * actually matters.
 *
 * Every method is asynchronous, unlike the Python sibling: a TypeScript store is a network call
 * more often than not, and `ManagedTemplateService` awaits throughout.
 */
export interface BaseTemplateManagerBackend {
  /**
   * Which filters this backend can honour, declaring only what it *cannot* do.
   *
   * Optional. A backend that says nothing is taken at
   * `DEFAULT_TEMPLATE_BACKEND_FILTER_CAPABILITIES` — fully capable — which is the same reading
   * a backend returning `{}` gets. Callers merge the report over the default, so a capability
   * added in a later release does not force every backend to re-declare it.
   */
  getFilterCapabilities?(): ManagedTemplateFilterCapabilities;

  /**
   * Create a new template's first version.
   *
   * Derive `isAbstract` from the source being stored — see the interface docs.
   */
  createTemplate(data: ManagedTemplateCreateInput): Promise<ManagedTemplate>;

  /**
   * One version of a template. `version` absent or `null` returns the latest version.
   *
   * @throws ManagedTemplateNotFoundError if the key (or that version of it) does not exist.
   */
  getTemplate(templateKey: string, version?: number | null): Promise<ManagedTemplate>;

  /**
   * Create a new version of an existing template, copied forward from its latest one.
   *
   * A new version is a new row, and the version it was copied from is left exactly as it was —
   * content, status and history. That is what versioning is for: a notification that already
   * went out against v1 renders v1 forever, however many versions follow it, and several
   * versions of one key are live at the same time as a matter of course.
   *
   * The new version starts in `draft` whatever its predecessor's status was, so a copy nobody
   * has reviewed is never published by the act of creating it. Fields left absent on the input —
   * tags included — carry forward from the version copied.
   *
   * `isAbstract` is re-derived from the new version's source rather than carried forward: an
   * edit that adds or removes a `{% managed_children %}` hole changes what the template is.
   *
   * @throws ManagedTemplateNotFoundError if the key does not exist.
   */
  updateTemplate(templateKey: string, data: ManagedTemplateUpdateInput): Promise<ManagedTemplate>;

  /**
   * Delete one version of a template, or its latest version when `version` is absent.
   *
   * @throws ManagedTemplateNotFoundError if the key (or that version of it) does not exist.
   */
  deleteTemplate(templateKey: string, version?: number | null): Promise<void>;

  /** Record a status change for one version in the audit trail. */
  createTemplateStatusUpdate(params: {
    templateKey: string;
    version: number;
    status: ManagedTemplateStatus;
    changedBy?: string | null;
  }): Promise<void>;

  /**
   * The status audit trail for a template.
   *
   * `version` absent asks for the whole key's history. Unlike everywhere else in this seam,
   * `version` absent here does *not* mean "the latest version".
   */
  getTemplateStatusHistory(
    templateKey: string,
    version?: number | null,
  ): Promise<ManagedTemplateStatusHistory[]>;

  // -------------------------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------------------------
  //
  // Tags are many-to-many with template versions and are identified by their slug, which the
  // backend derives from the text with `slugifyTag` and keeps unique across the store —
  // appending `-2`, `-3` and so on when a distinct text slugs onto a taken slug. Every method
  // below that takes a slug accepts the original text too: implementations slugify what they are
  // given before looking it up.

  /**
   * Resolve tag texts to tags, creating the ones that do not exist yet.
   *
   * This is the on-the-fly path every tagging call goes through: a caller tags a template with
   * what a person typed and never has to check first whether that tag exists. Texts that slugify
   * onto an existing tag resolve to it rather than creating a duplicate, and an existing tag is
   * returned as it stands — its text and status are left alone, so re-using an archived tag does
   * not quietly bring it back.
   *
   * @returns one tag per distinct text, in the order given.
   * @throws ManagedTemplateInvalidTagError if a text has nothing that can be slugified.
   */
  getOrCreateTags(texts: string[], tenant?: string | null): Promise<ManagedTemplateTag[]>;

  /**
   * Create a tag, failing if its text already slugs onto an existing one.
   *
   * Use `getOrCreateTags` when a duplicate should resolve to the existing tag; this is the
   * explicit-create path, where a collision is worth reporting to the caller.
   *
   * @throws ManagedTemplateTagAlreadyExistsError if a tag with that slug exists.
   * @throws ManagedTemplateInvalidTagError if the text has nothing that can be slugified.
   */
  createTag(text: string, tenant?: string | null): Promise<ManagedTemplateTag>;

  /**
   * One tag by slug (or by the text it was created from).
   *
   * @throws ManagedTemplateTagNotFoundError if no tag has that slug.
   */
  getTag(slug: string): Promise<ManagedTemplateTag>;

  /**
   * Rename a tag, regenerating its slug from the new text.
   *
   * The slug changes, so anything holding the old one — a bookmarked filter, a cached query —
   * stops matching. The tag keeps its identity and its templates: only the strings change.
   *
   * @throws ManagedTemplateTagNotFoundError if no tag has that slug.
   * @throws ManagedTemplateInvalidTagError if the new text has nothing to slugify.
   */
  updateTag(slug: string, text: string): Promise<ManagedTemplateTag>;

  /**
   * Archive a tag, or bring an archived one back.
   *
   * Archiving keeps every link to a template: filtering by an archived tag still returns the
   * templates carrying it. What archiving is for is dropping the tag out of the pickers a UI
   * builds from the active list.
   *
   * @throws ManagedTemplateTagNotFoundError if no tag has that slug.
   */
  setTagStatus(slug: string, status: ManagedTemplateTagStatus): Promise<ManagedTemplateTag>;

  /**
   * Delete a tag and remove it from every template carrying it.
   *
   * Unlike archiving, this is not reversible and the templates lose the label.
   *
   * @throws ManagedTemplateTagNotFoundError if no tag has that slug.
   */
  deleteTag(slug: string): Promise<void>;

  /**
   * Tags, optionally narrowed by status, by a text search, or by tenant.
   *
   * @param status every status when absent.
   * @param search a case-insensitive substring of the text or the slug.
   * @param tenant every tenant when absent.
   */
  getTags(
    status?: ManagedTemplateTagStatus[] | null,
    search?: string | null,
    tenant?: string | null,
  ): Promise<ManagedTemplateTag[]>;

  /**
   * The tags on one version of a template, or on its latest version.
   *
   * @throws ManagedTemplateNotFoundError if the key (or that version of it) does not exist.
   */
  getTemplateTags(templateKey: string, version?: number | null): Promise<ManagedTemplateTag[]>;

  /**
   * Replace the tags on one version of a template, creating any that do not exist.
   *
   * This edits a version in place rather than creating a new one, which is the one thing about a
   * template that does: tags are search metadata, not template content, so retagging for
   * findability should not spawn a version and reset it to `draft`.
   *
   * @param tags tag texts (or slugs). Empty clears the version's tags.
   * @throws ManagedTemplateNotFoundError if the key (or that version of it) does not exist.
   * @throws ManagedTemplateInvalidTagError if a text has nothing that can be slugified.
   */
  setTemplateTags(
    templateKey: string,
    tags: string[],
    version?: number | null,
  ): Promise<ManagedTemplate>;

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  /** Every version of every template in the store. */
  getAllTemplates(): Promise<ManagedTemplate[]>;

  /** Every template version in any of the given statuses. */
  getTemplatesByStatus(status: ManagedTemplateStatus[]): Promise<ManagedTemplate[]>;

  /**
   * The templates matching `filters`.
   *
   * Every field of `ManagedTemplateFilterFields` tests an attribute of the row — `isAbstract`
   * included, which is why it is stored rather than parsed here — with one exception:
   * `mostRecentActiveVersion` is about the *key*. `true` keeps only the highest-numbered version
   * of each key whose status is in `MOST_RECENT_ACTIVE_VERSION_STATUSES`, and `false` keeps every
   * other row — so an implementation answers it by comparing the row against its key's other
   * versions rather than by reading a field. It is what the service's listing methods apply by
   * default, so a backend that cannot evaluate it cannot serve a default listing.
   */
  getFilteredTemplates(filters: ManagedTemplateFilter): Promise<ManagedTemplate[]>;

  /**
   * One page of templates.
   *
   * @param page 1-indexed. `ManagedTemplateService` validates `page >= 1` before calling, so
   *   unlike `vintasend`'s notification backends there is no per-backend page numbering to
   *   negotiate.
   */
  getPaginatedTemplates(
    page: number,
    pageSize: number,
    orderBy?: ManagedTemplateOrderBy,
  ): Promise<ManagedTemplate[]>;

  /**
   * One page of the templates matching `filters`. `page` is 1-indexed.
   *
   * `orderBy` is optional and every `orderBy.*` capability defaults to false, so a backend
   * written before ordering existed keeps compiling and keeps its honest report. A backend that
   * *does* accept it must apply the order to the whole result set before paging, and must
   * declare the fields it can order by — a page sorted after it was chosen is sorted within
   * itself and wrong across page boundaries.
   */
  getPaginatedFilteredTemplates(
    filters: ManagedTemplateFilter,
    page: number,
    pageSize: number,
    orderBy?: ManagedTemplateOrderBy,
  ): Promise<ManagedTemplate[]>;
}
