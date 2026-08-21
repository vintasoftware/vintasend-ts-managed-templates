import { beforeEach, describe, expect, it } from 'vitest';

import {
  ManagedTemplateInvalidFilterError,
  ManagedTemplateInvalidTagError,
  ManagedTemplateStatusTransitionError,
} from '../errors.js';
import { InMemoryTemplateManagerBackend } from '../in-memory-template-manager-backend.js';
import { ManagedTemplateService } from '../managed-template-service.js';
import type { ManagedTemplateCreateInput } from '../types.js';
import { makeManagedEmailRenderer, makeNotification, type TestConfig } from './fakes.js';

function createInput(
  key: string,
  overrides: Partial<ManagedTemplateCreateInput> = {},
): ManagedTemplateCreateInput {
  return {
    key,
    name: key,
    description: '',
    templateManagedBackend: 'in-memory',
    bodyTemplate: '<p>Hi {name}</p>',
    subjectTemplate: 'Welcome',
    preheaderTemplate: null,
    tenant: null,
    ...overrides,
  };
}

let backend: InMemoryTemplateManagerBackend;
let service: ManagedTemplateService<TestConfig, { subject: string; body: string }>;

beforeEach(() => {
  backend = new InMemoryTemplateManagerBackend();
  const { renderer } = makeManagedEmailRenderer(backend);
  service = new ManagedTemplateService(backend, renderer);
});

describe('the status lifecycle', () => {
  it('publishes a draft', async () => {
    await service.createTemplate(createInput('welcome'));

    expect((await service.activate('welcome')).status).toBe('active');
  });

  it('refuses a move the lifecycle does not allow, and says what is allowed', async () => {
    await service.createTemplate(createInput('welcome'));

    await expect(service.deactivate('welcome')).rejects.toThrow(
      ManagedTemplateStatusTransitionError,
    );
    await expect(service.deactivate('welcome')).rejects.toThrow(/Allowed: active, archived/);
  });

  it('treats archived as terminal', async () => {
    await service.createTemplate(createInput('welcome'));
    await service.archive('welcome');

    await expect(service.activate('welcome')).rejects.toThrow(/Allowed: nothing/);
  });

  it('reports setting a version to the status it already holds as a no-op', async () => {
    await service.createTemplate(createInput('welcome'));
    await service.activate('welcome');

    const again = await service.activate('welcome');

    expect(again.status).toBe('active');
    expect(await service.getStatusHistory('welcome')).toHaveLength(1);
  });

  it('leaves other active versions of the same key alone', async () => {
    await service.createTemplate(createInput('welcome'));
    await service.activate('welcome', 1);
    await service.updateTemplate('welcome', { bodyTemplate: 'v2' });
    await service.activate('welcome', 2);

    expect((await service.getTemplate('welcome', 1)).status).toBe('active');
    expect((await service.getTemplate('welcome', 2)).status).toBe('active');
  });

  it('lets a host turn transition checking off entirely', async () => {
    const { renderer } = makeManagedEmailRenderer(backend);
    const loose = new ManagedTemplateService<TestConfig, { subject: string; body: string }>(
      backend,
      renderer,
      { validateStatusTransitions: false },
    );
    await loose.createTemplate(createInput('welcome'));

    expect((await loose.deactivate('welcome')).status).toBe('inactive');
  });

  it('answers which moves will work, excluding the status already held', async () => {
    await service.createTemplate(createInput('welcome'));
    const draft = await service.getTemplate('welcome');

    expect(service.allowedTransitionsFor(draft)).toEqual(['active', 'archived']);
  });

  it('sorts the audit trail most recent first', async () => {
    await service.createTemplate(createInput('welcome'));
    await service.activate('welcome', 1, 'ana');
    await service.archive('welcome', 1, 'bruno');

    const history = await service.getStatusHistory('welcome');

    expect(history.map((record) => record.status)).toEqual(['archived', 'active']);
    expect(history[0]?.changedBy).toBe('bruno');
  });

  it('passes changedBy through untouched, null included', async () => {
    await service.createTemplate(createInput('welcome'));
    await service.activate('welcome');

    expect((await service.getStatusHistory('welcome'))[0]?.changedBy).toBeNull();
  });
});

describe('versions', () => {
  it('lists every version newest first', async () => {
    await service.createTemplate(createInput('welcome'));
    await service.updateTemplate('welcome', {});
    await service.updateTemplate('welcome', {});

    expect((await service.getTemplateVersions('welcome')).map((t) => t.version)).toEqual([3, 2, 1]);
  });

  it('lists nothing for a key that does not exist', async () => {
    expect(await service.getTemplateVersions('nope')).toEqual([]);
  });
});

describe('listing defaults', () => {
  beforeEach(async () => {
    await service.createTemplate(createInput('welcome'));
    await service.updateTemplate('welcome', {});
    await service.createTemplate(createInput('receipt'));
  });

  it('shows one row per key by default', async () => {
    const listed = await service.getAllTemplates();

    expect(listed.map((t) => `${t.key}@${t.version}`).sort()).toEqual(['receipt@1', 'welcome@2']);
  });

  it('shows every version when asked', async () => {
    expect(await service.getAllTemplates(true)).toHaveLength(3);
  });

  it('applies the same default when paging', async () => {
    expect(await service.getPaginatedTemplates(1, 10)).toHaveLength(2);
    expect(await service.getPaginatedTemplates(1, 10, true)).toHaveLength(3);
  });

  it('refuses a page below 1', async () => {
    await expect(service.getPaginatedTemplates(0, 10)).rejects.toThrow(RangeError);
    await expect(service.getPaginatedTemplates(1, 0)).rejects.toThrow(RangeError);
  });
});

describe('filter validation', () => {
  it('names an unknown field and lists the known ones', async () => {
    await expect(service.getFilteredTemplates({ keyy: 'welcome' } as never)).rejects.toThrow(
      ManagedTemplateInvalidFilterError,
    );
    await expect(service.getFilteredTemplates({ keyy: 'x' } as never)).rejects.toThrow(
      /unknown field\(s\): keyy/,
    );
  });

  it('refuses a logical group carrying siblings', async () => {
    await expect(
      service.getFilteredTemplates({ and: [{ key: 'a' }], key: 'b' } as never),
    ).rejects.toThrow(/mixes a logical operator/);
  });

  it('refuses an and/or that is not an array, or is empty', async () => {
    await expect(service.getFilteredTemplates({ and: { key: 'a' } } as never)).rejects.toThrow(
      /must be an array of filters/,
    );
    await expect(service.getFilteredTemplates({ or: [] })).rejects.toThrow(/must not be empty/);
  });

  it('validates a nested group', async () => {
    await expect(service.getFilteredTemplates({ not: { nope: 1 } } as never)).rejects.toThrow(
      /filters\.not names unknown field/,
    );
  });

  it('refuses a bare string where a tag list belongs', async () => {
    await expect(
      service.getFilteredTemplates({ includesAllTags: 'welcome' } as never),
    ).rejects.toThrow(/must be an array of tag slugs/);
  });

  it('refuses a stringly-typed flag, which is what an unparsed query parameter looks like', async () => {
    await expect(
      service.getFilteredTemplates({ mostRecentActiveVersion: 'false' } as never),
    ).rejects.toThrow(/must be a boolean/);
  });

  it('accepts a well-formed nested filter', async () => {
    await service.createTemplate(createInput('welcome'));

    const found = await service.getFilteredTemplates({
      and: [{ key: 'welcome' }, { not: { status: 'active' } }],
    });

    expect(found).toHaveLength(1);
  });
});

describe('tag hygiene', () => {
  it('normalizes tag text before it reaches the backend', async () => {
    const template = await service.createTemplate(
      createInput('welcome', { tags: ['  Black   Friday '] }),
    );

    expect(template.tags[0]?.text).toBe('Black Friday');
    expect(template.tags[0]?.slug).toBe('black-friday');
  });

  it('drops repeats that slug onto a tag already in the list', async () => {
    const template = await service.createTemplate(
      createInput('welcome', { tags: ['Sale', 'sale', 'SALE'] }),
    );

    expect(template.tags).toHaveLength(1);
  });

  it('rejects text with nothing that can be turned into a slug', async () => {
    await expect(service.createTag('!!!')).rejects.toThrow(ManagedTemplateInvalidTagError);
    await expect(service.createTemplate(createInput('welcome', { tags: ['   '] }))).rejects.toThrow(
      ManagedTemplateInvalidTagError,
    );
  });

  it('adds tags without disturbing the ones already there', async () => {
    await service.createTemplate(createInput('welcome', { tags: ['a'] }));

    const tagged = await service.addTemplateTags('welcome', ['b']);

    expect(tagged.tags.map((tag) => tag.slug)).toEqual(['a', 'b']);
  });

  it('does nothing when every tag to add is already there', async () => {
    await service.createTemplate(createInput('welcome', { tags: ['a'] }));

    const tagged = await service.addTemplateTags('welcome', ['A']);

    expect(tagged.tags).toHaveLength(1);
  });

  it('unlinks a tag from a version without deleting it', async () => {
    await service.createTemplate(createInput('welcome', { tags: ['a', 'b'] }));

    const tagged = await service.removeTemplateTags('welcome', ['a']);

    expect(tagged.tags.map((tag) => tag.slug)).toEqual(['b']);
    expect(await service.getTags()).toHaveLength(2);
  });

  it('finds templates by all or any of their tags', async () => {
    await service.createTemplate(createInput('a', { tags: ['x', 'y'] }));
    await service.createTemplate(createInput('b', { tags: ['x'] }));

    expect(await service.getTemplatesByTags(['x', 'y'])).toHaveLength(1);
    expect(await service.getTemplatesByTags(['x', 'y'], false)).toHaveLength(2);
  });

  it('matches nothing for a tag search naming only unusable text', async () => {
    await service.createTemplate(createInput('a', { tags: ['x'] }));

    expect(await service.getTemplatesByTags(['!!!'], false)).toHaveLength(0);
  });

  it('offers only active tags to a picker', async () => {
    await service.createTag('a');
    await service.createTag('b');
    await service.archiveTag('b');

    expect((await service.getActiveTags()).map((tag) => tag.slug)).toEqual(['a']);
  });

  it('brings an archived tag back, unlike an archived version', async () => {
    await service.createTag('a');
    await service.archiveTag('a');

    expect((await service.restoreTag('a')).status).toBe('active');
  });
});

describe('composition through the service', () => {
  beforeEach(async () => {
    await service.createTemplate(
      createInput('base', { bodyTemplate: '<html>{% managed_children %}</html>' }),
    );
    await service.createTemplate(
      createInput('welcome', { bodyTemplate: '{% managed_extends "base" %}<p>Hi</p>' }),
    );
  });

  it('leaves a plain read literal about what is stored', async () => {
    expect((await service.getTemplate('welcome')).bodyTemplate).toBe(
      '{% managed_extends "base" %}<p>Hi</p>',
    );
  });

  it('assembles a template on request', async () => {
    expect((await service.getComposedTemplate('welcome')).bodyTemplate).toBe(
      '<html><p>Hi</p></html>',
    );
  });

  it('lists what a template directly references', async () => {
    const template = await service.getTemplate('welcome');

    expect(service.getTemplateReferences(template)).toEqual([
      { kind: 'extends', key: 'base', version: null, field: 'bodyTemplate' },
    ]);
  });

  it('recomputes abstractness from the source', async () => {
    expect(service.isAbstract(await service.getTemplate('base'))).toBe(true);
    expect(service.isAbstract(await service.getTemplate('welcome'))).toBe(false);
  });

  it('surfaces a broken composition at validation time', async () => {
    await service.createTemplate(
      createInput('orphan', { bodyTemplate: '{% managed_extends "gone" %}' }),
    );

    await expect(service.validateComposition(await service.getTemplate('orphan'))).rejects.toThrow(
      /'gone'/,
    );
  });

  it('hands a template back unassembled when composition is off', async () => {
    const { renderer } = makeManagedEmailRenderer(backend);
    const literal = new ManagedTemplateService<TestConfig, { subject: string; body: string }>(
      backend,
      renderer,
      { composeTemplates: false },
    );

    expect((await literal.getComposedTemplate('welcome')).bodyTemplate).toBe(
      '{% managed_extends "base" %}<p>Hi</p>',
    );
  });
});

describe('rendering through the service', () => {
  it('renders the version a notification is pinned to', async () => {
    await service.createTemplate(createInput('welcome', { bodyTemplate: 'v1' }));
    await service.updateTemplate('welcome', { bodyTemplate: 'v2' });

    const result = await service.render(makeNotification('welcome', 1), {});

    expect(result).toMatchObject({ version: 1 });
    expect(result.rendered.body).toBe('v1');
  });

  it('renders an explicit version, which is how a draft is previewed', async () => {
    await service.createTemplate(createInput('welcome', { bodyTemplate: 'v1' }));
    await service.updateTemplate('welcome', { bodyTemplate: 'draft' });

    const result = await service.render(makeNotification('welcome'), {}, 2);

    expect(result.rendered.body).toBe('draft');
  });

  it('renders a template already in hand with no backend read', async () => {
    await service.createTemplate(
      createInput('base', { bodyTemplate: '<b>{% managed_children %}</b>' }),
    );
    const edited = {
      ...(await service.getTemplate('base')),
      bodyTemplate: '{% managed_extends "base" %}unsaved',
      key: 'scratch',
      version: 7,
    };

    const result = await service.renderTemplate(makeNotification('scratch'), edited, {});

    expect(result).toMatchObject({ key: 'scratch', version: 7 });
    expect(result.rendered.body).toBe('<b>unsaved</b>');
  });
});

describe('capabilities', () => {
  it('takes a backend that reports nothing as fully capable', () => {
    expect(service.getBackendSupportedFilterCapabilities()['fields.key']).toBe(true);
  });

  it("merges a backend's report over the default", () => {
    const limited = Object.assign(new InMemoryTemplateManagerBackend(), {
      getFilterCapabilities: () => ({ 'logical.or': false }),
    });
    const { renderer } = makeManagedEmailRenderer(limited);
    const limitedService = new ManagedTemplateService<
      TestConfig,
      { subject: string; body: string }
    >(limited, renderer);

    const capabilities = limitedService.getBackendSupportedFilterCapabilities();

    expect(capabilities['logical.or']).toBe(false);
    expect(capabilities['logical.and']).toBe(true);
  });
});
