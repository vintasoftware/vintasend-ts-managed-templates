/**
 * Contract for creating a key twice and for blank / cleared subject and preheader fields,
 * driven through `ManagedTemplateService` so every backend is held to the same rules.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { ManagedTemplateAlreadyExistsError } from '../errors.js';
import { InMemoryTemplateManagerBackend } from '../in-memory-template-manager-backend.js';
import { ManagedTemplateService } from '../managed-template-service.js';
import type { ManagedTemplateCreateInput } from '../types.js';
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
    bodyTemplate: '<p>Hi</p>',
    subjectTemplate: 'Welcome',
    preheaderTemplate: 'Preview',
    tenant: null,
    ...overrides,
  };
}

let service: ManagedTemplateService<TestConfig, { subject: string; body: string }>;

beforeEach(() => {
  const backend = new InMemoryTemplateManagerBackend({ allowDeletingPublishedVersions: true });
  service = new ManagedTemplateService(backend, makeManagedEmailRenderer(backend).renderer, {
    allowDeletingPublishedVersions: true,
  });
});

describe('creating a key twice', () => {
  it('throws and leaves the versions unchanged', async () => {
    await service.createTemplate(createInput('welcome', { name: 'A' }));
    await service.activate('welcome', 1);

    await expect(service.createTemplate(createInput('welcome', { name: 'B' }))).rejects.toThrow(
      ManagedTemplateAlreadyExistsError,
    );

    const versions = await service.getTemplateVersions('welcome');
    expect(versions.map((v) => [v.version, v.name, v.status])).toEqual([[1, 'A', 'active']]);
  });

  it('numbers a re-created key above the history of its deleted versions', async () => {
    await service.createTemplate(createInput('welcome'));
    await service.activate('welcome', 1);
    await service.updateTemplate('welcome', { name: 'v2' });
    await service.activate('welcome', 2);
    // Published versions leave a status history, which is what keeps their numbers taken.
    await service.deleteTemplate('welcome', 2);
    await service.deleteTemplate('welcome', 1);

    const recreated = await service.createTemplate(createInput('welcome'));

    expect(recreated.version).toBe(3);
  });
});

describe('blank subject and preheader', () => {
  it.each(['', '   '])('stores %j on create as no value', async (blank) => {
    const template = await service.createTemplate(
      createInput('welcome', { subjectTemplate: blank, preheaderTemplate: blank }),
    );

    expect(template.subjectTemplate).toBeNull();
    expect(template.preheaderTemplate).toBeNull();
  });

  it('clears a field on update even when the latest version has one', async () => {
    await service.createTemplate(createInput('welcome'));

    const next = await service.updateTemplate('welcome', {
      subjectTemplate: '',
      preheaderTemplate: '  ',
    });

    expect(next.subjectTemplate).toBeNull();
    expect(next.preheaderTemplate).toBeNull();
  });

  it('carries a field forward on null or undefined', async () => {
    await service.createTemplate(createInput('welcome'));

    const next = await service.updateTemplate('welcome', {
      subjectTemplate: null,
      preheaderTemplate: undefined,
    });

    expect(next.subjectTemplate).toBe('Welcome');
    expect(next.preheaderTemplate).toBe('Preview');
  });
});
