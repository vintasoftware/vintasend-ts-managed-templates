/**
 * The filter vocabulary a template-manager backend evaluates.
 *
 * Spelled exactly the way `vintasend` spells its notification filters — camelCase fields,
 * camelCase string lookups (`startsWith`, not `starts_with`), a `DateRange` with `from`/`to`,
 * and the same `and`/`or`/`not` grouping — so a caller that already builds one kind of filter
 * needs no second set of rules for this one.
 */

import type { ManagedTemplateStatus } from './constants.js';

/** Date range filter with optional lower and upper bounds. */
export type DateRange = {
  from?: Date;
  to?: Date;
};

export type StringFilterLookup = {
  lookup: 'exact' | 'startsWith' | 'endsWith' | 'includes';
  value: string;
  caseSensitive?: boolean;
};

/** A bare string is a case-sensitive `exact` match. */
export type StringFieldFilter = string | StringFilterLookup;

export type NumericFilterLookup = {
  lookup: 'gt' | 'gte' | 'lt' | 'lte';
  value: number;
};

export type IntegerFieldFilter = number | NumericFilterLookup;

export type ManagedTemplateStatusFilter =
  | ManagedTemplateStatus
  | { lookup: 'exact'; value: ManagedTemplateStatus }
  | { lookup: 'in'; value: ManagedTemplateStatus[] };

/**
 * A tag filter is a plain list of tag slugs — no lookup wrapper, because which of the two
 * matches is meant is already said by the field name (`includesAllTags` / `includesAnyOfTags`)
 * rather than by a `lookup` key.
 *
 * Values are matched against `ManagedTemplateTag.slug`. Backends slugify what they are given
 * first, so a caller may pass either the slug or the text it came from and get the same result.
 */
export type TagsFieldFilter = string[];

/**
 * Leaf-level filter conditions. Every field present is combined with implicit AND.
 */
export type ManagedTemplateFilterFields = {
  name?: StringFieldFilter;
  description?: StringFieldFilter;
  key?: StringFieldFilter;
  version?: IntegerFieldFilter;
  templateManagedBackend?: StringFieldFilter;
  status?: ManagedTemplateStatusFilter;
  createdAtRange?: DateRange;
  updatedAtRange?: DateRange;
  /**
   * Tag membership. `includesAllTags` matches a template carrying every listed tag,
   * `includesAnyOfTags` one carrying at least one of them. Both follow `Array.every` /
   * `Array.some` on an empty list: an empty `includesAllTags` constrains nothing, an empty
   * `includesAnyOfTags` matches nothing.
   */
  includesAllTags?: TagsFieldFilter;
  includesAnyOfTags?: TagsFieldFilter;
  /**
   * Bases, or templates to send. `true` keeps only the templates that declare a
   * `{% managed_children %}` hole or blocks without extending anything; `false` keeps only the
   * ones that do not.
   *
   * Answered against the stored `ManagedTemplate.isAbstract` — a field a backend writes on
   * every write — rather than by parsing sources at query time, which is the whole reason the
   * flag is denormalized: a picker that has to exclude bases would otherwise read and parse
   * every row in the store to draw one page.
   */
  isAbstract?: boolean;
  /**
   * One row per key instead of one row per version. `true` keeps, for each key, only the
   * highest-numbered version whose status is in `MOST_RECENT_ACTIVE_VERSION_STATUSES` (`active`
   * or `draft`), and drops every key with no such version. `false` is its exact complement —
   * every other row, retired keys included — so it is what `{ not: { mostRecentActiveVersion:
   * true } }` means.
   *
   * This is the one field whose answer depends on the *other* rows in the store rather than on
   * the row being tested, so a backend evaluates it against the whole key, not the row.
   */
  mostRecentActiveVersion?: boolean;
};

export type ManagedTemplateFilter =
  | ManagedTemplateFilterFields
  | { and: ManagedTemplateFilter[] }
  | { or: ManagedTemplateFilter[] }
  | { not: ManagedTemplateFilter };

/**
 * The fields `ManagedTemplateFilterFields` accepts, as data.
 *
 * Kept in step with the type by {@link ManagedTemplateFilterFieldName}, which fails to compile
 * if the two drift apart — a field added to the type without a name here is a type error rather
 * than a filter the service silently rejects.
 */
export const KNOWN_FILTER_FIELDS = [
  'name',
  'description',
  'key',
  'version',
  'templateManagedBackend',
  'status',
  'createdAtRange',
  'updatedAtRange',
  'includesAllTags',
  'includesAnyOfTags',
  'isAbstract',
  'mostRecentActiveVersion',
] as const satisfies readonly (keyof ManagedTemplateFilterFields)[];

type ManagedTemplateFilterFieldName = (typeof KNOWN_FILTER_FIELDS)[number];

// Fails to compile if a field is added to the type but not to the list above.
type _AllFilterFieldsListed =
  keyof ManagedTemplateFilterFields extends ManagedTemplateFilterFieldName
    ? true
    : [
        'missing from KNOWN_FILTER_FIELDS',
        Exclude<keyof ManagedTemplateFilterFields, ManagedTemplateFilterFieldName>,
      ];
const _allFilterFieldsListed: _AllFilterFieldsListed = true;
void _allFilterFieldsListed;

/** The filter fields whose value is a list of tag slugs rather than a lookup object. */
export const TAG_FILTER_FIELDS = ['includesAllTags', 'includesAnyOfTags'] as const;

/** The filter fields whose value is a bare boolean. */
export const FLAG_FILTER_FIELDS = ['mostRecentActiveVersion', 'isAbstract'] as const;

const LOGICAL_KEYS = ['and', 'or', 'not'] as const;
const STRING_LOOKUPS = ['exact', 'startsWith', 'endsWith', 'includes'];
const NUMERIC_LOOKUPS = ['gt', 'gte', 'lt', 'lte'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `filter` is a field filter rather than an `and`/`or`/`not` group. */
export function isFieldFilter(
  filter: ManagedTemplateFilter,
): filter is ManagedTemplateFilterFields {
  return !LOGICAL_KEYS.some((key) => key in filter);
}

/** True when a string-field filter is a `StringFilterLookup` and not a bare string. */
export function isStringFilterLookup(value: unknown): value is StringFilterLookup {
  return (
    isRecord(value) &&
    typeof value.value === 'string' &&
    typeof value.lookup === 'string' &&
    STRING_LOOKUPS.includes(value.lookup) &&
    (value.caseSensitive === undefined || typeof value.caseSensitive === 'boolean')
  );
}

export function isNumericFilterLookup(value: unknown): value is NumericFilterLookup {
  return (
    isRecord(value) &&
    typeof value.value === 'number' &&
    typeof value.lookup === 'string' &&
    NUMERIC_LOOKUPS.includes(value.lookup)
  );
}

export function isDateRange(value: unknown): value is DateRange {
  return isRecord(value) && (value.from instanceof Date || value.to instanceof Date);
}

export function isStatusInLookup(
  value: unknown,
): value is { lookup: 'in'; value: ManagedTemplateStatus[] } {
  return (
    isRecord(value) &&
    value.lookup === 'in' &&
    Array.isArray(value.value) &&
    value.value.every((entry) => typeof entry === 'string')
  );
}

export function isStatusExactLookup(
  value: unknown,
): value is { lookup: 'exact'; value: ManagedTemplateStatus } {
  return isRecord(value) && value.lookup === 'exact' && typeof value.value === 'string';
}

/**
 * True when a value is a list of tag slugs.
 *
 * A bare string is deliberately rejected: `{ includesAllTags: 'welcome' }` would otherwise be
 * spread character by character by a backend that iterates it, and silently ask for the tags
 * `w`, `e`, `l`. Pass a one-element array instead.
 */
export function isTagsFilter(value: unknown): value is TagsFieldFilter {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Which filters a template-manager backend can honour.
 *
 * Follows the same rule as `vintasend`'s notification capabilities: **a backend declares only
 * what it cannot do.** Its report is merged *over* an all-`true` default, so a filter field
 * added in a later release does not force every backend to re-declare support for it, and a
 * missing key means "supported".
 *
 * `orderBy.*` keys report which fields a backend can sort a page by. They are new vocabulary, so
 * they default to **false**: a backend that predates ordering ignores the argument, and claiming
 * an order it does not apply is worse than admitting it cannot — a caller that knows gets to
 * decide, while one that is lied to silently renders rows in an arbitrary order and calls it
 * sorted.
 *
 * Ordering has to reach the store rather than being applied to the page afterwards. Sorting a
 * page after the fact orders rows *within* the page while the rows chosen *for* it stayed in the
 * backend's own order, which looks right on page 1 and is wrong everywhere after it.
 */
export type ManagedTemplateFilterCapabilities = {
  [key: string]: boolean;
};

/**
 * The fields a template listing can be ordered by.
 *
 * Deliberately narrow: each one is a scalar the backend already stores per row, so a store can
 * answer it with an index rather than a computed sort. `tags` is absent because ordering by a
 * many-to-many has no single value to compare, and `mostRecentActiveVersion` because it is a
 * filter rather than a field.
 */
export type ManagedTemplateOrderByField =
  | 'key'
  | 'name'
  | 'version'
  | 'status'
  | 'createdAt'
  | 'updatedAt';

export type ManagedTemplateOrderDirection = 'asc' | 'desc';

export type ManagedTemplateOrderBy = {
  field: ManagedTemplateOrderByField;
  direction: ManagedTemplateOrderDirection;
};

/** Every orderable field, for validation and for building a capability report. */
export const MANAGED_TEMPLATE_ORDER_BY_FIELDS: readonly ManagedTemplateOrderByField[] = [
  'key',
  'name',
  'version',
  'status',
  'createdAt',
  'updatedAt',
];

/** The capability key reporting whether a backend can order by `field`. */
export function orderByCapabilityKey(field: ManagedTemplateOrderByField): string {
  return `orderBy.${field}`;
}

export const DEFAULT_TEMPLATE_BACKEND_FILTER_CAPABILITIES: ManagedTemplateFilterCapabilities = {
  // Composition. A backend that can evaluate field filters but not assemble them into
  // and/or/not groups declines these. `notNested` is the narrower question of whether `not` may
  // wrap a *group* rather than a single field filter.
  'logical.and': true,
  'logical.or': true,
  'logical.not': true,
  'logical.notNested': true,
  // One key per field of `ManagedTemplateFilterFields`.
  'fields.name': true,
  'fields.description': true,
  'fields.key': true,
  'fields.version': true,
  'fields.templateManagedBackend': true,
  'fields.status': true,
  'fields.createdAtRange': true,
  'fields.updatedAtRange': true,
  // Tag membership. A backend that stores no tags — or stores them but cannot query across
  // them — declines these, and a caller drops the filter rather than failing the request. They
  // are separate keys because "every tag" and "at least one tag" are different queries: the
  // first needs a per-template count over the tags asked for, the second only membership.
  'fields.includesAllTags': true,
  'fields.includesAnyOfTags': true,
  // Its own key because it is a different question from the rest: a backend answers it by
  // comparing a row against the other versions of its key, which a store that keeps no version
  // history cannot do.
  'fields.mostRecentActiveVersion': true,
  // Bases versus templates to send, answered from the stored `isAbstract` flag the backend
  // derives on every write. A backend that keeps no such flag declines this.
  'fields.isAbstract': true,
  'stringLookups.exact': true,
  'stringLookups.startsWith': true,
  'stringLookups.endsWith': true,
  'stringLookups.includes': true,
  // These two are independent capabilities, not a flag and its negation:
  //
  // * `caseSensitive: false` — everything is forced case-insensitive, which is what a store on
  //   a case-insensitive collation (MySQL's `*_ci`) does. It cannot honour
  //   `caseSensitive: true`, nor a bare string filter, which means the same thing.
  // * `caseInsensitive: false` — only exact-case matching is available, e.g. a store with
  //   `LIKE` but no `ILIKE`.
  //
  // Deriving either from the other inverts the answer for exactly the backends that had a
  // constraint worth reporting. Read the key you actually mean.
  'stringLookups.caseSensitive': true,
  'stringLookups.caseInsensitive': true,
  // Ordering is new vocabulary rather than behaviour backends already have, so every key
  // defaults to false. A backend that predates the ordering argument ignores it, and a `true`
  // default would have it claim an order it never applies.
  'orderBy.key': false,
  'orderBy.name': false,
  'orderBy.version': false,
  'orderBy.status': false,
  'orderBy.createdAt': false,
  'orderBy.updatedAt': false,
};

/**
 * Drop the parts of a filter the backend has declared it cannot answer.
 *
 * This is the other half of the capability report: reporting a limitation is only useful if
 * something acts on it. Every caller that builds a filter would otherwise have to walk the
 * capability map itself and reach its own conclusions, and they would disagree.
 *
 * **Dropping widens.** A pruned filter matches everything the original did and possibly more, so
 * a caller sees extra rows rather than missing ones — a listing that could not collapse to one
 * row per key shows every version, which is visible in the result. That is the whole reason
 * filters are negotiated by dropping while *ordering* is negotiated by refusing: an ignored order
 * leaves no trace in the rows at all. Check the report before trusting a filter to have narrowed.
 *
 * Returns an empty filter — which constrains nothing — when everything has been dropped.
 */
export function pruneUnsupportedFilters(
  filter: ManagedTemplateFilter,
  capabilities: ManagedTemplateFilterCapabilities,
): ManagedTemplateFilter {
  const can = (key: string) => supportsCapability(capabilities, key);

  if (isFieldFilter(filter)) {
    return pruneFields(filter, can);
  }

  if ('and' in filter) {
    if (!can('logical.and')) {
      return {};
    }
    const kept = filter.and
      .map((inner) => pruneUnsupportedFilters(inner, capabilities))
      .filter((inner) => !isEmptyFilter(inner));
    if (kept.length === 0) return {};
    // A one-element `and` is the element: fewer groups for a backend to translate.
    return kept.length === 1 ? (kept[0] as ManagedTemplateFilter) : { and: kept };
  }

  if ('or' in filter) {
    // An `or` cannot be partially dropped. Removing one branch of a disjunction *narrows* the
    // result — the opposite of what dropping is allowed to do — so the whole group goes, and
    // with it the constraint.
    if (!can('logical.or')) {
      return {};
    }
    const kept = filter.or.map((inner) => pruneUnsupportedFilters(inner, capabilities));
    // If any branch pruned down to "everything", the disjunction is satisfied by every row.
    if (kept.some(isEmptyFilter)) return {};
    return { or: kept };
  }

  if (!can('logical.not')) {
    return {};
  }
  const inner = pruneUnsupportedFilters(filter.not, capabilities);
  // Negating "everything" is "nothing", which is not a widening — drop it instead.
  if (isEmptyFilter(inner)) return {};
  if (!isFieldFilter(inner) && !can('logical.notNested')) return {};
  return { not: inner };
}

/** True for a filter that constrains nothing, whatever shape it arrived in. */
export function isEmptyFilter(filter: ManagedTemplateFilter): boolean {
  if (isFieldFilter(filter)) {
    return Object.values(filter).every((value) => value === undefined);
  }
  if ('and' in filter) return filter.and.every(isEmptyFilter);
  if ('or' in filter) return filter.or.every(isEmptyFilter);
  return isEmptyFilter(filter.not);
}

function pruneFields(
  fields: ManagedTemplateFilterFields,
  can: (key: string) => boolean,
): ManagedTemplateFilterFields {
  const kept: Record<string, unknown> = {};

  for (const field of KNOWN_FILTER_FIELDS) {
    const value = (fields as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (!can(`fields.${field}`)) continue;
    if (isStringFilterLookup(value) && !supportedStringLookup(value, can)) continue;
    // A bare string means exact and case-sensitive.
    if (
      typeof value === 'string' &&
      !(can('stringLookups.exact') && can('stringLookups.caseSensitive'))
    ) {
      continue;
    }
    kept[field] = value;
  }

  return kept as ManagedTemplateFilterFields;
}

function supportedStringLookup(filter: StringFilterLookup, can: (key: string) => boolean): boolean {
  if (!can(`stringLookups.${filter.lookup}`)) return false;
  return filter.caseSensitive === false
    ? can('stringLookups.caseInsensitive')
    : can('stringLookups.caseSensitive');
}

/**
 * Read one capability, defaulting to supported.
 *
 * A missing key means "supported": backends declare only what they *cannot* do, so a capability
 * added in a later release does not force every backend to re-declare it.
 */
export function supportsCapability(
  capabilities: ManagedTemplateFilterCapabilities,
  key: string,
): boolean {
  return capabilities[key] ?? true;
}
