/**
 * Negotiating a filter against what a backend says it can answer.
 *
 * The invariant every case here checks is **dropping only ever widens**. A pruned filter must
 * match everything the original matched, and may match more. A prune that narrowed would hide
 * rows the caller asked for, with nothing in the result to show it happened.
 */

import { describe, expect, it } from 'vitest';

import { matchesTemplateFilter } from '../filter-evaluation.js';
import {
  isEmptyFilter,
  type ManagedTemplateFilter,
  type ManagedTemplateFilterCapabilities,
  pruneUnsupportedFilters,
} from '../filters.js';
import type { ManagedTemplate } from '../types.js';

function prune(filter: ManagedTemplateFilter, capabilities: ManagedTemplateFilterCapabilities) {
  return pruneUnsupportedFilters(filter, capabilities);
}

function row(overrides: Partial<ManagedTemplate> = {}): ManagedTemplate {
  return {
    key: 'welcome',
    version: 1,
    name: 'Welcome',
    description: '',
    templateManagedBackend: 'test',
    bodyTemplate: '',
    subjectTemplate: null,
    preheaderTemplate: null,
    status: 'active',
    isAbstract: false,
    tenant: null,
    tags: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  } as ManagedTemplate;
}

describe('fields', () => {
  it('keeps a field the backend supports', () => {
    expect(prune({ key: 'welcome' }, {})).toEqual({ key: 'welcome' });
  });

  it('drops a field the backend cannot answer', () => {
    expect(prune({ key: 'welcome', version: 2 }, { 'fields.version': false })).toEqual({
      key: 'welcome',
    });
  });

  it('drops the default listing filter for a backend that cannot collapse versions', () => {
    // The case that made this necessary: the service's own default listing asks for one row per
    // key, and a backend that cannot answer it should return every version, not throw.
    expect(
      prune({ mostRecentActiveVersion: true }, { 'fields.mostRecentActiveVersion': false }),
    ).toEqual({});
  });

  it('drops a string lookup the backend does not offer', () => {
    expect(
      prune({ name: { lookup: 'endsWith', value: 'ome' } }, { 'stringLookups.endsWith': false }),
    ).toEqual({});
  });

  it('drops a case-insensitive lookup against a case-sensitive-only backend', () => {
    expect(
      prune(
        { name: { lookup: 'exact', value: 'Welcome', caseSensitive: false } },
        { 'stringLookups.caseInsensitive': false },
      ),
    ).toEqual({});
  });

  it('treats a bare string as exact and case-sensitive when deciding', () => {
    // A bare string means the same thing as `{ lookup: 'exact', caseSensitive: true }`, so a
    // backend that cannot match case-sensitively cannot answer it either.
    expect(prune({ key: 'welcome' }, { 'stringLookups.caseSensitive': false })).toEqual({});
  });
});

describe('status is a token, not a string', () => {
  // A status is matched by `matchesStatus`, not `matchesString` — it is enum equality on a wire
  // value, and no collation affects it. The `stringLookups.*` keys describe how a store compares
  // *text*, so none of them has anything to say about a status filter. `fields.status` does.

  it('keeps a bare status against a case-insensitive-only backend', () => {
    expect(prune({ status: 'active' }, { 'stringLookups.caseSensitive': false })).toEqual({
      status: 'active',
    });
  });

  it('keeps a bare status against a backend that declines exact string matching', () => {
    expect(prune({ status: 'active' }, { 'stringLookups.exact': false })).toEqual({
      status: 'active',
    });
  });

  it('keeps an exact status lookup against a case-insensitive-only backend', () => {
    const filter: ManagedTemplateFilter = { status: { lookup: 'exact', value: 'active' } };

    expect(prune(filter, { 'stringLookups.caseSensitive': false })).toEqual(filter);
  });

  it('keeps an exact status lookup against a backend that declines exact string matching', () => {
    const filter: ManagedTemplateFilter = { status: { lookup: 'exact', value: 'active' } };

    expect(prune(filter, { 'stringLookups.exact': false })).toEqual(filter);
  });

  it('negotiates both spellings of a status filter the same way', () => {
    // `{ lookup: 'in' }` always survived, because `in` is not a string lookup. The `exact` form
    // says the same thing about one value, and used to be dropped instead.
    const capabilities = { 'stringLookups.exact': false, 'stringLookups.caseSensitive': false };

    expect(prune({ status: { lookup: 'in', value: ['active'] } }, capabilities)).not.toEqual({});
    expect(prune({ status: { lookup: 'exact', value: 'active' } }, capabilities)).not.toEqual({});
  });

  it('still drops a status the backend cannot filter on at all', () => {
    // `fields.status` is the capability that does govern a status filter.
    expect(prune({ status: 'active' }, { 'fields.status': false })).toEqual({});
    expect(
      prune({ status: { lookup: 'exact', value: 'active' } }, { 'fields.status': false }),
    ).toEqual({});
  });

  it('still drops a genuine string field against the same backend', () => {
    // The control. A fix that stopped pruning string lookups altogether would pass every case
    // above and fail this one: `name` *is* text, so a store that cannot compare it
    // case-sensitively cannot answer a bare `name` filter.
    expect(prune({ name: 'Welcome' }, { 'stringLookups.caseSensitive': false })).toEqual({});
    expect(
      prune({ name: { lookup: 'endsWith', value: 'ome' } }, { 'stringLookups.endsWith': false }),
    ).toEqual({});
  });
});

describe('groups', () => {
  it('drops an or group the backend cannot evaluate', () => {
    // Keeping one branch would *narrow* the result, which is the one thing pruning may not do.
    const filter: ManagedTemplateFilter = { or: [{ key: 'a' }, { key: 'b' }] };

    expect(prune(filter, { 'logical.or': false })).toEqual({});
  });

  it('drops a not group the backend cannot evaluate', () => {
    expect(prune({ not: { key: 'a' } }, { 'logical.not': false })).toEqual({});
  });

  it('keeps an and group, pruning inside it', () => {
    const filter: ManagedTemplateFilter = { and: [{ key: 'a' }, { version: 2 }] };

    expect(prune(filter, { 'fields.version': false })).toEqual({ key: 'a' });
  });

  it('collapses an and group down to nothing when every branch goes', () => {
    const filter: ManagedTemplateFilter = { and: [{ version: 2 }, { version: 3 }] };

    expect(prune(filter, { 'fields.version': false })).toEqual({});
  });

  it('drops a whole or group when one branch prunes to everything', () => {
    // `(key = a) OR (anything)` is satisfied by every row, so the group constrains nothing.
    const filter: ManagedTemplateFilter = { or: [{ key: 'a' }, { version: 2 }] };

    expect(prune(filter, { 'fields.version': false })).toEqual({});
  });

  it('drops a negation whose inside pruned away', () => {
    // `NOT (anything)` is "nothing", which would narrow to an empty result rather than widen.
    expect(prune({ not: { version: 2 } }, { 'fields.version': false })).toEqual({});
  });

  it('drops a nested negation against a backend that only negates single fields', () => {
    const filter: ManagedTemplateFilter = { not: { and: [{ key: 'a' }, { status: 'active' }] } };

    expect(prune(filter, { 'logical.notNested': false })).toEqual({});
  });
});

describe('the widening invariant', () => {
  const rows = [
    row({ key: 'a', version: 1, status: 'active' }),
    row({ key: 'b', version: 2, status: 'draft' }),
    row({ key: 'c', version: 3, status: 'archived' }),
  ];

  const cases: Array<[string, ManagedTemplateFilter, ManagedTemplateFilterCapabilities]> = [
    ['a dropped field', { key: 'a', version: 1 }, { 'fields.version': false }],
    ['a dropped or', { or: [{ key: 'a' }, { key: 'b' }] }, { 'logical.or': false }],
    ['a dropped not', { not: { key: 'a' } }, { 'logical.not': false }],
    [
      'a partially pruned and',
      { and: [{ status: 'active' }, { version: 1 }] },
      { 'fields.version': false },
    ],
    // Kept rather than dropped, so the invariant here is that keeping it was safe: the pruned
    // filter still matches every row the original did, which for an unchanged filter means the
    // evaluator agrees the status constraint was answerable all along.
    ['a kept status filter', { status: 'active' }, { 'stringLookups.caseSensitive': false }],
    [
      'a kept status lookup',
      { status: { lookup: 'exact', value: 'active' } },
      { 'stringLookups.exact': false },
    ],
  ];

  for (const [label, filter, capabilities] of cases) {
    it(`keeps every row the original matched: ${label}`, () => {
      const pruned = prune(filter, capabilities);

      for (const template of rows) {
        if (matchesTemplateFilter(template, filter)) {
          expect(matchesTemplateFilter(template, pruned)).toBe(true);
        }
      }
    });
  }
});

describe('isEmptyFilter', () => {
  it('recognises an empty filter whatever shape it arrived in', () => {
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({ key: undefined })).toBe(true);
    expect(isEmptyFilter({ and: [{}, {}] })).toBe(true);
    expect(isEmptyFilter({ or: [{}] })).toBe(true);
    expect(isEmptyFilter({ not: {} })).toBe(true);
  });

  it('does not call a real constraint empty', () => {
    expect(isEmptyFilter({ key: 'a' })).toBe(false);
    expect(isEmptyFilter({ and: [{}, { key: 'a' }] })).toBe(false);
  });
});
