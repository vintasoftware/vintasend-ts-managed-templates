/**
 * Evaluating a `ManagedTemplateFilter` against templates already in hand.
 *
 * Not every store can push every filter down. A SQL backend can; a FHIR one cannot express `or`
 * at all, and a document store may have no way to ask "does this row carry all of these tags".
 * Rather than have each of those backends re-derive what a filter means — and disagree with the
 * others on the corners — this module is the one implementation of the semantics, and a backend
 * narrows server-side as far as it can and finishes here.
 *
 * That makes the fallback sound by construction: whatever a backend's query language can express
 * is an optimization, and what it cannot express is still answered correctly.
 */

import { type ManagedTemplateStatus, MOST_RECENT_ACTIVE_VERSION_STATUSES } from './constants.js';
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
  type ManagedTemplateOrderBy,
  type ManagedTemplateStatusFilter,
  type StringFieldFilter,
} from './filters.js';
import { slugifyTag } from './tags.js';
import type { ManagedTemplate } from './types.js';

export type FilterEvaluationContext = {
  /**
   * Every version of one key, needed only by `mostRecentActiveVersion` — the one field whose
   * answer depends on the *other* rows in the store rather than on the row being tested.
   *
   * A filter that names that field without this available cannot be answered, so
   * {@link matchesTemplateFilter} throws rather than guessing.
   */
  versionsOfKey?: (key: string) => readonly ManagedTemplate[];
};

export function matchesString(value: string, filter: StringFieldFilter): boolean {
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

export function matchesInteger(value: number, filter: IntegerFieldFilter): boolean {
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

export function matchesStatus(
  value: ManagedTemplateStatus,
  filter: ManagedTemplateStatusFilter,
): boolean {
  if (isStatusInLookup(filter)) {
    return filter.value.includes(value);
  }
  if (isStatusExactLookup(filter)) {
    return value === filter.value;
  }
  return value === filter;
}

/**
 * Whether a date falls in a range.
 *
 * A row whose date is unset never matches a positive range — the same NULL rule `vintasend`'s
 * notification date ranges follow — but `createdAt` and `updatedAt` are always set on a stored
 * template, so this only comes up for a template assembled by hand.
 */
export function matchesDateRange(value: Date | null | undefined, range: DateRange): boolean {
  if (!(value instanceof Date)) {
    return false;
  }
  if (range.from !== undefined && value.getTime() < range.from.getTime()) {
    return false;
  }
  if (range.to !== undefined && value.getTime() > range.to.getTime()) {
    return false;
  }
  return true;
}

/**
 * Whether a row is its key's current version.
 *
 * "This row is active or draft, and no active-or-draft row of the same key is numbered higher."
 * Written as a comparison against the key's other versions rather than as a lookup, because that
 * is what the field means — see `ManagedTemplateFilterFields.mostRecentActiveVersion`.
 */
export function isMostRecentActiveVersion(
  template: ManagedTemplate,
  versions: readonly ManagedTemplate[],
): boolean {
  if (!MOST_RECENT_ACTIVE_VERSION_STATUSES.includes(template.status)) {
    return false;
  }
  return !versions.some(
    (candidate) =>
      candidate.key === template.key &&
      MOST_RECENT_ACTIVE_VERSION_STATUSES.includes(candidate.status) &&
      candidate.version > template.version,
  );
}

/** Whether one template satisfies a filter, groups and all. */
export function matchesTemplateFilter(
  template: ManagedTemplate,
  filter: ManagedTemplateFilter,
  context: FilterEvaluationContext = {},
): boolean {
  if (!isFieldFilter(filter)) {
    if ('and' in filter) {
      return filter.and.every((sub) => matchesTemplateFilter(template, sub, context));
    }
    if ('or' in filter) {
      return filter.or.some((sub) => matchesTemplateFilter(template, sub, context));
    }
    return !matchesTemplateFilter(template, filter.not, context);
  }
  return matchesFields(template, filter, context);
}

function matchesFields(
  template: ManagedTemplate,
  filters: ManagedTemplateFilterFields,
  context: FilterEvaluationContext,
): boolean {
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
    const carried = new Set(template.tags.map((tag) => tag.slug));
    if (!normalizeSlugs(filters.includesAllTags).every((slug) => carried.has(slug))) {
      return false;
    }
  }
  if (filters.includesAnyOfTags !== undefined) {
    const carried = new Set(template.tags.map((tag) => tag.slug));
    if (!normalizeSlugs(filters.includesAnyOfTags).some((slug) => carried.has(slug))) {
      return false;
    }
  }
  if (filters.isAbstract !== undefined && template.isAbstract !== filters.isAbstract) {
    return false;
  }
  if (filters.mostRecentActiveVersion !== undefined) {
    if (context.versionsOfKey === undefined) {
      throw new Error(
        "mostRecentActiveVersion is answered against a key's other versions, so " +
          'matchesTemplateFilter needs a versionsOfKey lookup to evaluate it.',
      );
    }
    const current = isMostRecentActiveVersion(template, context.versionsOfKey(template.key));
    if (current !== filters.mostRecentActiveVersion) {
      return false;
    }
  }
  return true;
}

/**
 * Slugify a filter's tag values, dropping the ones that name no tag.
 *
 * A caller may name a tag by its slug or by the text behind it, so this is what makes
 * `includesAllTags: ['Black Friday']` and `includesAllTags: ['black-friday']` the same query.
 */
export function normalizeSlugs(tags: readonly string[]): string[] {
  return tags.map((tag) => slugifyTag(tag)).filter(Boolean);
}

/** Slice a 1-indexed page out of a complete, ordered result set. */
/**
 * Order templates by one field, for a backend whose store cannot do it.
 *
 * Sorting in memory is only correct over a **complete** result set — sort a page and you order
 * rows within it while the rows chosen for it came back in the store's own order. So this is for
 * a backend that reads everything anyway, and such a backend must still report `orderBy.*`
 * honestly: it can sort, so it says `true`.
 *
 * The sort is total and stable. Every field falls back to `(key, version)` on a tie, so two rows
 * that compare equal on the named field still come back in the same order on every call — a page
 * boundary that moves between two requests silently drops or repeats rows.
 */
export function sortTemplates(
  templates: readonly ManagedTemplate[],
  orderBy: ManagedTemplateOrderBy | undefined,
): ManagedTemplate[] {
  const rows = [...templates];
  if (orderBy === undefined) {
    return rows;
  }

  const sign = orderBy.direction === 'desc' ? -1 : 1;
  return rows.sort((left, right) => {
    // Absent values sort last in *both* directions, so this is compared before the sign is
    // applied. `createdAt` and `updatedAt` are typed non-null, but a backend hydrating them from
    // a store that allows null would otherwise put its nulls first on `desc` and last on `asc`.
    const nullness = compareNullness(left, right, orderBy.field);
    if (nullness !== 0) {
      return nullness;
    }
    const primary = compareField(left, right, orderBy.field);
    if (primary !== 0) {
      return primary * sign;
    }
    // The tiebreak is *not* reversed either: it exists to make the order total, and flipping it
    // with the direction would make `asc` and `desc` disagree on which of two equal rows comes
    // first — which is how a page boundary starts dropping and repeating rows.
    return compareTiebreak(left, right);
  });
}

/** -1, 0 or 1 according to which side is missing a value for `field`; 0 when both have one. */
function compareNullness(
  left: ManagedTemplate,
  right: ManagedTemplate,
  field: ManagedTemplateOrderBy['field'],
): number {
  const leftMissing = (left[field] ?? null) === null;
  const rightMissing = (right[field] ?? null) === null;
  if (leftMissing === rightMissing) return 0;
  return leftMissing ? 1 : -1;
}

function compareField(
  left: ManagedTemplate,
  right: ManagedTemplate,
  field: ManagedTemplateOrderBy['field'],
): number {
  switch (field) {
    case 'key':
      return compareStrings(left.key, right.key);
    case 'name':
      return compareStrings(left.name, right.name);
    case 'status':
      return compareStrings(left.status, right.status);
    case 'version':
      return left.version - right.version;
    case 'createdAt':
      return compareDates(left.createdAt, right.createdAt);
    case 'updatedAt':
      return compareDates(left.updatedAt, right.updatedAt);
  }
}

function compareTiebreak(left: ManagedTemplate, right: ManagedTemplate): number {
  return compareStrings(left.key, right.key) || left.version - right.version;
}

/**
 * Compare by code point rather than by locale.
 *
 * `localeCompare` would order rows differently depending on where the process runs, which for a
 * paginated read means two pages of the same listing served by two machines can disagree.
 */
function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Only reached with two present values — `compareNullness` has already settled the rest. */
function compareDates(left: Date | null | undefined, right: Date | null | undefined): number {
  return (left?.getTime() ?? 0) - (right?.getTime() ?? 0);
}

export function paginate<Row>(rows: readonly Row[], page: number, pageSize: number): Row[] {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}
