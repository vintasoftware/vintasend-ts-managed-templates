import { beforeEach, describe, expect, it } from 'vitest';

import { ManagedTemplateNoActiveVersionError, ManagedTemplateNotFoundError } from '../errors.js';
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
    bodyTemplate: 'p v1',
    subjectTemplate: null,
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

describe('an unpinned send', () => {
  it('renders the published version, not a newer draft', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.updateTemplate('k', { bodyTemplate: 'p v2draft' });
    const { renderer } = makeManagedEmailRenderer(backend);

    const rendered = await renderer.render(makeNotification('k'), {});

    expect(rendered.body).toBe('p v1');
    expect(rendered.templateVersion).toBe(1);
  });

  it('throws a not-found subclass for a key that only has drafts', async () => {
    await service.createTemplate(createInput('k'));
    const { renderer } = makeManagedEmailRenderer(backend);

    const attempt = renderer.render(makeNotification('k'), {});

    await expect(attempt).rejects.toThrow(ManagedTemplateNoActiveVersionError);
    await expect(renderer.render(makeNotification('k'), {})).rejects.toBeInstanceOf(
      ManagedTemplateNotFoundError,
    );
  });

  it('renders the highest-numbered active version when several are active', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.updateTemplate('k', { bodyTemplate: 'p v2' });
    await service.activate('k', 2);
    await service.updateTemplate('k', { bodyTemplate: 'p v3draft' });
    const { renderer } = makeManagedEmailRenderer(backend);

    const rendered = await renderer.render(makeNotification('k'), {});

    expect(rendered.body).toBe('p v2');
    expect(rendered.templateVersion).toBe(2);
  });

  it('skips a newer version that was deactivated', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.updateTemplate('k', { bodyTemplate: 'p v2' });
    await service.activate('k', 2);
    await service.deactivate('k', 2);
    const { renderer } = makeManagedEmailRenderer(backend);

    expect((await renderer.render(makeNotification('k'), {})).templateVersion).toBe(1);
  });

  it('resolves renderManaged with no version the same way a send does', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.updateTemplate('k', { bodyTemplate: 'p v2draft' });

    const result = await service.render(makeNotification('k'), {});

    expect(result.version).toBe(1);
  });
});

describe('a pinned send', () => {
  it('keeps rendering its pinned version after that version is deactivated', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.deactivate('k', 1);
    const { renderer } = makeManagedEmailRenderer(backend);

    const rendered = await renderer.render(makeNotification('k', 1), {});

    expect(rendered.body).toBe('p v1');
    expect(rendered.templateVersion).toBe(1);
  });
});

describe('getLatestTemplateVersion', () => {
  it('pins a new notification to the active version, not a newer draft', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.updateTemplate('k', { bodyTemplate: 'p v2draft' });
    const { renderer } = makeManagedEmailRenderer(backend);

    expect(await renderer.getLatestTemplateVersion('k')).toBe(1);
  });

  it('answers null for a key that only has drafts', async () => {
    await service.createTemplate(createInput('k'));
    const { renderer } = makeManagedEmailRenderer(backend);

    expect(await renderer.getLatestTemplateVersion('k')).toBeNull();
  });

  it('answers the highest active version when several are active', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.updateTemplate('k', {});
    await service.activate('k', 2);
    const { renderer } = makeManagedEmailRenderer(backend);

    expect(await renderer.getLatestTemplateVersion('k')).toBe(2);
  });
});

describe('the editing view', () => {
  it('still reads the newest version, whatever its status', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.updateTemplate('k', { bodyTemplate: 'p v2draft' });

    expect((await service.getTemplate('k')).version).toBe(2);
  });
});

describe('getActiveTemplate', () => {
  it('is answered by the in-memory backend', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.updateTemplate('k', {});

    expect((await backend.getActiveTemplate('k')).version).toBe(1);
  });

  it('tells a missing key apart from a key with no active version', async () => {
    await service.createTemplate(createInput('k'));

    await expect(backend.getActiveTemplate('nope')).rejects.toThrow(ManagedTemplateNotFoundError);
    await expect(backend.getActiveTemplate('nope')).rejects.not.toBeInstanceOf(
      ManagedTemplateNoActiveVersionError,
    );
    await expect(backend.getActiveTemplate('k')).rejects.toThrow(
      ManagedTemplateNoActiveVersionError,
    );
  });

  it('is derived from the filter seam for a backend that does not implement it', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.updateTemplate('k', {});
    await service.activate('k', 2);
    await service.updateTemplate('k', {});
    const legacy = Object.assign(Object.create(backend), { getActiveTemplate: undefined });
    const legacyService = new ManagedTemplateService<TestConfig, { subject: string; body: string }>(
      legacy,
      makeManagedEmailRenderer(legacy).renderer,
    );

    expect((await legacyService.getActiveTemplate('k')).version).toBe(2);
    await expect(legacyService.getActiveTemplate('nope')).rejects.toThrow(
      ManagedTemplateNotFoundError,
    );
  });
});
