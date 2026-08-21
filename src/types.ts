import type { ManagedTemplateStatus, ManagedTemplateTagStatus } from './constants.js';

/**
 * Whatever a store uses to key a row. Mirrors `vintasend`'s own `Identifier`: a backend on
 * Postgres hands back a number, one on FHIR a string, and neither is this package's business.
 */
export type ManagedTemplateId = string | number;

/**
 * A label attached to any number of template versions, and versions carry any number of them.
 *
 * `slug` is the identity: it is normalized from `text` by {@link slugifyTag}, unique across the
 * store, and what the tag filters match on. Editing `text` regenerates it.
 */
export type ManagedTemplateTag = {
  id: ManagedTemplateId;
  text: string;
  slug: string;
  status: ManagedTemplateTagStatus;
  createdAt: Date;
  updatedAt: Date;
  tenant: string | null;
};

/**
 * One version of a managed template.
 *
 * Templates are versioned rather than edited in place, so a `ManagedTemplate` is always a
 * specific version of `key` — never "the template" in the abstract.
 */
export type ManagedTemplate = {
  id: ManagedTemplateId;
  key: string;
  version: number;
  name: string;
  description: string;
  templateManagedBackend: string;
  bodyTemplate: string;
  subjectTemplate: string | null;
  preheaderTemplate: string | null;
  status: ManagedTemplateStatus;
  tenant: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Every tag on this version, in the order the backend returns them. */
  tags: ManagedTemplateTag[];
  /**
   * Whether this is a base to build on rather than a template to send: it declares a
   * `{% managed_children %}` hole, or declares blocks without extending anything.
   *
   * Denormalized, not authored. Nobody sets it on a write — there is no field for it on either
   * write input — because it is a fact about the source, and a stored copy that disagreed with
   * the source would be a lie a filter repeats. A backend derives it on every write with
   * {@link isAbstract} and stores the answer so a query can use it; `isAbstract` recomputed is
   * always the authority.
   */
  isAbstract: boolean;
};

/** One entry in a template version's status audit trail. */
export type ManagedTemplateStatusHistory = {
  templateKey: string;
  version: number;
  status: ManagedTemplateStatus;
  createdAt: Date;
  changedBy: string | null;
  tenant: string | null;
};

/** What creating a template's first version needs. */
export type ManagedTemplateCreateInput = {
  key: string;
  name: string;
  description: string;
  templateManagedBackend: string;
  bodyTemplate: string;
  subjectTemplate: string | null;
  preheaderTemplate: string | null;
  tenant: string | null;
  /**
   * Tag *texts*, not slugs: a caller tags a template with what a person typed, and any text
   * with no tag behind it yet becomes one. `null`, `undefined` and `[]` all mean "no tags".
   */
  tags?: string[] | null;
};

/**
 * What creating the *next* version of an existing key needs.
 *
 * Every field is optional and an absent one means "carry this one forward": the backend copies
 * the latest version and applies only the fields that are set. There is deliberately no
 * `templateManagedBackend` or `tenant` here — neither can change across versions of one key.
 */
export type ManagedTemplateUpdateInput = {
  name?: string | null;
  description?: string | null;
  bodyTemplate?: string | null;
  subjectTemplate?: string | null;
  preheaderTemplate?: string | null;
  /**
   * Unlike the other fields, tags distinguish absent from empty: absent carries the previous
   * version's tags forward, `[]` creates the version with none.
   */
  tags?: string[] | null;
};
