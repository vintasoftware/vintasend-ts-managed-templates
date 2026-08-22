/**
 * Ordering: the capability vocabulary, the shared comparator, and the service's refusal.
 *
 * The rule these tests exist to hold is that an order is either applied or refused, never
 * silently dropped. An ignored filter returns more rows than asked for and a caller can see it;
 * an ignored order returns exactly the right rows in an arbitrary sequence and nothing
 * downstream can tell.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { BaseTemplateManagerBackend } from '../base-template-manager-backend.js';
import { ManagedTemplateUnsupportedOrderingError } from '../errors.js';
import { sortTemplates } from '../filter-evaluation.js';
import {
  DEFAULT_TEMPLATE_BACKEND_FILTER_CAPABILITIES,
  MANAGED_TEMPLATE_ORDER_BY_FIELDS,
  type ManagedTemplateFilterCapabilities,
  orderByCapabilityKey,
} from '../filters.js';
import { InMemoryTemplateManagerBackend } from '../in-memory-template-manager-backend.js';
import { ManagedTemplateService } from '../managed-template-service.js';
import type { ManagedTemplate, ManagedTemplateCreateInput } from '../types.js';
import { makeManagedEmailRenderer, type TestConfig } from './fakes.js';

function createInput(
  key: string,
  overrides: Partial<ManagedTemplateCreateInput> = {},
): ManagedTemplateCreateInput {
  return {
    key,
    name: key,
    description: '',
    templateManagedBackend: 'in-memory',
    bodyTemplate: '<p>hi</p>',
    subjectTemplate: 'Hi',
    preheaderTemplate: null,
    tenant: null,
    ...overrides,
  };
}

/** A bare template, for exercising the comparator without a store. */
function row(overrides: Partial<ManagedTemplate>): ManagedTemplate {
  return {
    key: 'k',
    version: 1,
    name: 'n',
    description: '',
    templateManagedBackend: 'in-memory',
    bodyTemplate: '',
    subjectTemplate: null,
    preheaderTemplate: null,
    status: 'draft',
    isAbstract: false,
    tenant: null,
    tags: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  } as ManagedTemplate;
}

describe('capability vocabulary', () => {
  it('defaults every orderBy field to unsupported', () => {
    // New vocabulary defaults to false, so a backend written before ordering existed does not
    // claim an order it will never apply.
    for (const field of MANAGED_TEMPLATE_ORDER_BY_FIELDS) {
      expect(DEFAULT_TEMPLATE_BACKEND_FILTER_CAPABILITIES[orderByCapabilityKey(field)]).toBe(false);
    }
  });

  it('has a default entry for every orderable field', () => {
    // A field in the vocabulary with no default would read as supported through
    // `supportsCapability`, which is the exact trap the false defaults exist to avoid.
    for (const field of MANAGED_TEMPLATE_ORDER_BY_FIELDS) {
      expect(DEFAULT_TEMPLATE_BACKEND_FILTER_CAPABILITIES).toHaveProperty(
        orderByCapabilityKey(field),
      );
    }
  });
});

describe('sortTemplates', () => {
  it('returns the rows untouched when no order is given', () => {
    const rows = [row({ key: 'b' }), row({ key: 'a' })];

    expect(sortTemplates(rows, undefined).map((r) => r.key)).toEqual(['b', 'a']);
  });

  it('orders by a string field in both directions', () => {
    const rows = [row({ key: 'c' }), row({ key: 'a' }), row({ key: 'b' })];

    expect(sortTemplates(rows, { field: 'key', direction: 'asc' }).map((r) => r.key)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(sortTemplates(rows, { field: 'key', direction: 'desc' }).map((r) => r.key)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('orders by version numerically, not lexicographically', () => {
    const rows = [row({ version: 10 }), row({ version: 9 }), row({ version: 2 })];

    expect(
      sortTemplates(rows, { field: 'version', direction: 'asc' }).map((r) => r.version),
    ).toEqual([2, 9, 10]);
  });

  it('sorts nulls last in both directions', () => {
    const rows = [
      row({ key: 'a', updatedAt: null }),
      row({ key: 'b', updatedAt: new Date('2026-05-01') }),
    ];

    expect(sortTemplates(rows, { field: 'updatedAt', direction: 'asc' }).map((r) => r.key)).toEqual(
      ['b', 'a'],
    );
    expect(
      sortTemplates(rows, { field: 'updatedAt', direction: 'desc' }).map((r) => r.key),
    ).toEqual(['b', 'a']);
  });

  it('breaks ties on (key, version) so the order is total', () => {
    const rows = [
      row({ key: 'b', version: 1, name: 'same' }),
      row({ key: 'a', version: 2, name: 'same' }),
      row({ key: 'a', version: 1, name: 'same' }),
    ];

    expect(
      sortTemplates(rows, { field: 'name', direction: 'asc' }).map((r) => `${r.key}@${r.version}`),
    ).toEqual(['a@1', 'a@2', 'b@1']);
  });

  it('does not reverse the tiebreak with the direction', () => {
    // Reversing it would make asc and desc disagree about which of two equal rows comes first,
    // which is how a page boundary starts dropping and repeating rows between requests.
    const rows = [row({ key: 'b', name: 'same' }), row({ key: 'a', name: 'same' })];

    expect(sortTemplates(rows, { field: 'name', direction: 'desc' }).map((r) => r.key)).toEqual([
      'a',
      'b',
    ]);
  });

  it('leaves the input array alone', () => {
    const rows = [row({ key: 'b' }), row({ key: 'a' })];

    sortTemplates(rows, { field: 'key', direction: 'asc' });

    expect(rows.map((r) => r.key)).toEqual(['b', 'a']);
  });
});

describe('the in-memory backend', () => {
  let backend: InMemoryTemplateManagerBackend;

  beforeEach(async () => {
    backend = new InMemoryTemplateManagerBackend();
    for (const key of ['charlie', 'alpha', 'bravo']) {
      await backend.createTemplate(createInput(key));
    }
  });

  it('declares every order it can apply', () => {
    // It holds the whole store, so it can sort a complete set before paging — and has to say so,
    // because the default is false.
    const capabilities = backend.getFilterCapabilities();

    for (const field of MANAGED_TEMPLATE_ORDER_BY_FIELDS) {
      expect(capabilities[orderByCapabilityKey(field)]).toBe(true);
    }
  });

  it('orders a page', async () => {
    const page = await backend.getPaginatedTemplates(1, 10, { field: 'key', direction: 'asc' });

    expect(page.map((t) => t.key)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('sorts before paging rather than after', async () => {
    // The distinction the seam turns on: page 1 of a descending sort must be the *last* rows of
    // the ascending one, not the first rows re-sorted among themselves.
    const page = await backend.getPaginatedTemplates(1, 2, { field: 'key', direction: 'desc' });

    expect(page.map((t) => t.key)).toEqual(['charlie', 'bravo']);
  });

  it('pages an ordered filtered read without repeating or dropping a row', async () => {
    const order = { field: 'key', direction: 'asc' } as const;
    const first = await backend.getPaginatedFilteredTemplates({}, 1, 2, order);
    const second = await backend.getPaginatedFilteredTemplates({}, 2, 2, order);

    expect([...first, ...second].map((t) => t.key)).toEqual(['alpha', 'bravo', 'charlie']);
  });
});

describe('the service', () => {
  function serviceWith(capabilities: ManagedTemplateFilterCapabilities) {
    const backend = new InMemoryTemplateManagerBackend();
    // Override the reference backend's honest report to model a store that cannot sort.
    (backend as BaseTemplateManagerBackend).getFilterCapabilities = () => capabilities;
    const { renderer } = makeManagedEmailRenderer(backend);
    return new ManagedTemplateService<TestConfig, { subject: string; body: string }>(
      backend,
      renderer,
    );
  }

  const everything = Object.fromEntries(
    MANAGED_TEMPLATE_ORDER_BY_FIELDS.map((field) => [orderByCapabilityKey(field), true]),
  );

  it('refuses an order the backend cannot apply', async () => {
    const service = serviceWith({ ...everything, 'orderBy.name': false });

    await expect(
      service.getPaginatedTemplates(1, 10, false, { field: 'name', direction: 'asc' }),
    ).rejects.toThrow(ManagedTemplateUnsupportedOrderingError);
  });

  it('names the capability key in the error, so the fix is findable', async () => {
    const service = serviceWith({ ...everything, 'orderBy.name': false });

    await expect(
      service.getPaginatedTemplates(1, 10, false, { field: 'name', direction: 'asc' }),
    ).rejects.toThrow(/orderBy\.name/);
  });

  it('allows an order the backend declares', async () => {
    const service = serviceWith(everything);

    await expect(
      service.getPaginatedTemplates(1, 10, false, { field: 'key', direction: 'asc' }),
    ).resolves.toEqual([]);
  });

  it('refuses a field outside the vocabulary', async () => {
    const service = serviceWith(everything);

    await expect(
      service.getPaginatedTemplates(1, 10, false, {
        field: 'bodyTemplate' as never,
        direction: 'asc',
      }),
    ).rejects.toThrow(ManagedTemplateUnsupportedOrderingError);
  });

  it('refuses a direction that is not asc or desc', async () => {
    const service = serviceWith(everything);

    await expect(
      service.getPaginatedTemplates(1, 10, false, { field: 'key', direction: 'sideways' as never }),
    ).rejects.toThrow(ManagedTemplateUnsupportedOrderingError);
  });

  it('asks for nothing when no order is given', async () => {
    // A backend that supports no ordering at all still serves an unordered listing.
    const service = serviceWith({});

    await expect(service.getPaginatedTemplates(1, 10)).resolves.toEqual([]);
  });

  it('reports which fields are orderable', () => {
    const service = serviceWith({ ...everything, 'orderBy.name': false, 'orderBy.status': false });

    expect(service.getSupportedOrderByFields()).toEqual([
      'key',
      'version',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('reports nothing orderable for a backend that declares nothing', () => {
    const service = serviceWith({});

    expect(service.getSupportedOrderByFields()).toEqual([]);
  });

  it('passes the order through to the backend', async () => {
    const service = serviceWith(everything);
    for (const key of ['charlie', 'alpha']) {
      await service.createTemplate(createInput(key));
    }

    const page = await service.getPaginatedTemplates(1, 10, true, {
      field: 'key',
      direction: 'asc',
    });

    expect(page.map((t) => t.key)).toEqual(['alpha', 'charlie']);
  });
});
