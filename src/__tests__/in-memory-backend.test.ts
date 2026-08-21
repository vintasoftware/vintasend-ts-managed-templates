/**
 * The storage seam's semantics, exercised through the reference implementation.
 *
 * Every rule asserted here is one `BaseTemplateManagerBackend` documents in prose, so this file
 * doubles as the conformance suite a new backend can be read against.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  ManagedTemplateNotFoundError,
  ManagedTemplateTagAlreadyExistsError,
  ManagedTemplateTagNotFoundError,
} from '../errors.js';
import { InMemoryTemplateManagerBackend } from '../in-memory-template-manager-backend.js';
import type { ManagedTemplateCreateInput } from '../types.js';

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

let backend: InMemoryTemplateManagerBackend;

beforeEach(() => {
  backend = new InMemoryTemplateManagerBackend();
});

describe('versions', () => {
  it('starts a new template at version 1 in draft', async () => {
    const template = await backend.createTemplate(createInput('welcome'));

    expect(template.version).toBe(1);
    expect(template.status).toBe('draft');
  });

  it('copies the latest version forward and starts the copy in draft', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
    });

    const next = await backend.updateTemplate('welcome', { name: 'Welcome!' });

    expect(next.version).toBe(2);
    expect(next.status).toBe('draft');
    expect(next.name).toBe('Welcome!');
    // Carried forward, because the input left it unset.
    expect(next.bodyTemplate).toBe('<p>hi</p>');
  });

  it('leaves the version it copied from exactly as it was', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
    });
    await backend.updateTemplate('welcome', { bodyTemplate: '<p>new</p>' });

    const first = await backend.getTemplate('welcome', 1);

    expect(first.status).toBe('active');
    expect(first.bodyTemplate).toBe('<p>hi</p>');
  });

  it('resolves an absent version to the latest one', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.updateTemplate('welcome', {});

    expect((await backend.getTemplate('welcome')).version).toBe(2);
  });

  it('reports a missing key and a missing version differently', async () => {
    await backend.createTemplate(createInput('welcome'));

    await expect(backend.getTemplate('nope')).rejects.toThrow(ManagedTemplateNotFoundError);
    await expect(backend.getTemplate('welcome', 9)).rejects.toThrow(/has no version 9/);
  });

  it('deletes one version, never the whole key', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.updateTemplate('welcome', {});

    await backend.deleteTemplate('welcome', 2);

    expect((await backend.getTemplate('welcome')).version).toBe(1);
  });

  it('re-derives isAbstract from the new version rather than carrying it forward', async () => {
    await backend.createTemplate(
      createInput('base', { bodyTemplate: '<b>{% managed_children %}</b>' }),
    );
    expect((await backend.getTemplate('base')).isAbstract).toBe(true);

    const next = await backend.updateTemplate('base', { bodyTemplate: '<b>concrete</b>' });

    expect(next.isAbstract).toBe(false);
  });

  it('stores isAbstract as false rather than failing a write on a malformed tag', async () => {
    const template = await backend.createTemplate(
      createInput('broken', { bodyTemplate: '{% managed_endblock %}' }),
    );

    expect(template.isAbstract).toBe(false);
  });
});

describe('status history', () => {
  it('records every change with who made it', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
      changedBy: 'ana',
    });

    const history = await backend.getTemplateStatusHistory('welcome');

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'active', version: 1, changedBy: 'ana' });
  });

  it('narrows to one version when asked', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.updateTemplate('welcome', {});
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
    });
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 2,
      status: 'active',
    });

    expect(await backend.getTemplateStatusHistory('welcome', 2)).toHaveLength(1);
    expect(await backend.getTemplateStatusHistory('welcome')).toHaveLength(2);
  });
});

describe('tags', () => {
  it('creates tags on the fly when a template names them', async () => {
    const template = await backend.createTemplate(
      createInput('welcome', { tags: ['Black Friday'] }),
    );

    expect(template.tags.map((tag) => tag.slug)).toEqual(['black-friday']);
    expect(await backend.getTags()).toHaveLength(1);
  });

  it('resolves a text that slugs onto an existing tag to that tag', async () => {
    await backend.createTemplate(createInput('a', { tags: ['Black Friday'] }));
    const second = await backend.createTemplate(createInput('b', { tags: ['black friday'] }));

    expect(await backend.getTags()).toHaveLength(1);
    expect(second.tags[0]?.text).toBe('Black Friday');
  });

  it('does not bring an archived tag back by re-using it', async () => {
    await backend.createTemplate(createInput('a', { tags: ['sale'] }));
    await backend.setTagStatus('sale', 'archived');

    const second = await backend.createTemplate(createInput('b', { tags: ['sale'] }));

    expect(second.tags[0]?.status).toBe('archived');
  });

  it('refuses an explicit create that collides', async () => {
    await backend.createTag('Sale');

    await expect(backend.createTag('sale')).rejects.toThrow(ManagedTemplateTagAlreadyExistsError);
  });

  it('regenerates the slug on a rename, suffixing a collision', async () => {
    await backend.createTag('Sale');
    const other = await backend.createTag('Clearance');

    const renamed = await backend.updateTag(other.slug, 'Sale');

    expect(renamed.slug).toBe('sale-2');
    expect(renamed.text).toBe('Sale');
  });

  it('looks a tag up by the text it was created from', async () => {
    await backend.createTag('Black Friday');

    expect((await backend.getTag('Black Friday')).slug).toBe('black-friday');
  });

  it('keeps every link when a tag is archived and severs them when it is deleted', async () => {
    await backend.createTemplate(createInput('welcome', { tags: ['sale'] }));

    await backend.setTagStatus('sale', 'archived');
    expect(await backend.getTemplateTags('welcome')).toHaveLength(1);

    await backend.deleteTag('sale');
    expect(await backend.getTemplateTags('welcome')).toHaveLength(0);
  });

  it('reports a missing tag', async () => {
    await expect(backend.getTag('nope')).rejects.toThrow(ManagedTemplateTagNotFoundError);
  });

  it('narrows tags by status, search and tenant', async () => {
    await backend.createTag('Black Friday', 'acme');
    await backend.createTag('Cyber Monday', 'other');
    await backend.setTagStatus('cyber-monday', 'archived');

    expect(await backend.getTags(['active'])).toHaveLength(1);
    expect(await backend.getTags(null, 'monday')).toHaveLength(1);
    expect(await backend.getTags(null, null, 'acme')).toHaveLength(1);
  });

  it('retags a version in place, without spawning one', async () => {
    await backend.createTemplate(createInput('welcome', { tags: ['a'] }));

    const retagged = await backend.setTemplateTags('welcome', ['b', 'c']);

    expect(retagged.version).toBe(1);
    expect(retagged.tags.map((tag) => tag.slug)).toEqual(['b', 'c']);
  });

  it('clears a version tags with an empty list', async () => {
    await backend.createTemplate(createInput('welcome', { tags: ['a'] }));

    expect((await backend.setTemplateTags('welcome', [])).tags).toEqual([]);
  });
});

describe('filtering', () => {
  beforeEach(async () => {
    await backend.createTemplate(createInput('welcome', { name: 'Welcome email' }));
    await backend.createTemplate(createInput('receipt', { name: 'Receipt email' }));
  });

  it('matches a bare string as a case-sensitive exact match', async () => {
    expect(await backend.getFilteredTemplates({ key: 'welcome' })).toHaveLength(1);
    expect(await backend.getFilteredTemplates({ key: 'Welcome' })).toHaveLength(0);
  });

  it('honours every string lookup', async () => {
    expect(
      await backend.getFilteredTemplates({ name: { lookup: 'startsWith', value: 'Welcome' } }),
    ).toHaveLength(1);
    expect(
      await backend.getFilteredTemplates({ name: { lookup: 'endsWith', value: 'email' } }),
    ).toHaveLength(2);
    expect(
      await backend.getFilteredTemplates({
        name: { lookup: 'includes', value: 'RECEIPT', caseSensitive: false },
      }),
    ).toHaveLength(1);
  });

  it('combines fields with AND and groups with and/or/not', async () => {
    expect(await backend.getFilteredTemplates({ key: 'welcome', status: 'draft' })).toHaveLength(1);
    expect(
      await backend.getFilteredTemplates({ or: [{ key: 'welcome' }, { key: 'receipt' }] }),
    ).toHaveLength(2);
    expect(await backend.getFilteredTemplates({ not: { key: 'welcome' } })).toHaveLength(1);
  });

  it('matches all of no tags and none of any of no tags', async () => {
    expect(await backend.getFilteredTemplates({ includesAllTags: [] })).toHaveLength(2);
    expect(await backend.getFilteredTemplates({ includesAnyOfTags: [] })).toHaveLength(0);
  });

  it('accepts a tag named by the text behind its slug', async () => {
    await backend.setTemplateTags('welcome', ['Black Friday']);

    expect(await backend.getFilteredTemplates({ includesAllTags: ['black friday'] })).toHaveLength(
      1,
    );
  });

  it('keeps only the current version of each key for mostRecentActiveVersion', async () => {
    await backend.updateTemplate('welcome', {}); // v2, draft
    await backend.updateTemplate('welcome', {}); // v3, draft

    const current = await backend.getFilteredTemplates({ mostRecentActiveVersion: true });

    expect(current.filter((template) => template.key === 'welcome')).toHaveLength(1);
    expect(current.find((template) => template.key === 'welcome')?.version).toBe(3);
  });

  it('drops a key whose versions are all retired', async () => {
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
    });
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'archived',
    });

    const current = await backend.getFilteredTemplates({ mostRecentActiveVersion: true });

    expect(current.some((template) => template.key === 'welcome')).toBe(false);
  });

  it('treats mostRecentActiveVersion false as the exact complement', async () => {
    await backend.updateTemplate('welcome', {}); // v2

    const older = await backend.getFilteredTemplates({ mostRecentActiveVersion: false });

    expect(older.map((template) => `${template.key}@${template.version}`)).toEqual(['welcome@1']);
  });

  it('pages a filtered result 1-indexed', async () => {
    const first = await backend.getPaginatedFilteredTemplates({}, 1, 1);
    const second = await backend.getPaginatedFilteredTemplates({}, 2, 1);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.key).not.toBe(second[0]?.key);
  });
});
