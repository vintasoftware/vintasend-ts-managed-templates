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
export function paginate<Row>(rows: readonly Row[], page: number, pageSize: number): Row[] {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}
