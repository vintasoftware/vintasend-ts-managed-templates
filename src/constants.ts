/**
 * The vocabulary every other module in this package is written against.
 *
 * Statuses are string unions rather than enums, matching how `vintasend` spells
 * `NotificationStatus`: the values travel over HTTP and through a database as strings, and a
 * union keeps the stored form and the typed form the same thing.
 */

export const MANAGED_TEMPLATE_STATUSES = ['draft', 'active', 'inactive', 'archived'] as const;

export type ManagedTemplateStatus = (typeof MANAGED_TEMPLATE_STATUSES)[number];

/**
 * The statuses a version has to be in to count as its key's current one for the
 * `mostRecentActiveVersion` filter: what is published now, plus the draft on its way to
 * replacing it. `inactive` and `archived` versions are history — a key whose versions are all
 * retired has no current version at all and drops out of that filter entirely.
 */
export const MOST_RECENT_ACTIVE_VERSION_STATUSES: readonly ManagedTemplateStatus[] = [
  'active',
  'draft',
];

/**
 * Whether a tag is still offered when tagging a template.
 *
 * `archived` retires a tag from the pickers and suggestion lists a UI builds without breaking
 * the templates already carrying it: an archived tag keeps its links, and filtering by it keeps
 * working. Deleting the tag is the operation that severs those links.
 */
export const MANAGED_TEMPLATE_TAG_STATUSES = ['active', 'archived'] as const;

export type ManagedTemplateTagStatus = (typeof MANAGED_TEMPLATE_TAG_STATUSES)[number];

/**
 * The three sources a template carries, composed independently and each against the same field
 * of whatever it references.
 */
export const TEMPLATE_FIELDS = ['bodyTemplate', 'subjectTemplate', 'preheaderTemplate'] as const;

export type TemplateField = (typeof TEMPLATE_FIELDS)[number];
