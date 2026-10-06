import { beforeEach, describe, expect, it } from 'vitest';

import type { BaseTemplateManagerBackend } from '../base-template-manager-backend.js';
import { ManagedTemplateDeletionNotAllowedError, ManagedTemplateNotFoundError } from '../errors.js';
import { InMemoryTemplateManagerBackend } from '../in-memory-template-manager-backend.js';
import { isTemplateVersionDeletable } from '../lifecycle.js';
import { ManagedTemplateService } from '../managed-template-service.js';
import type { ManagedTemplateCreateInput } from '../types.js';
import { makeManagedEmailRenderer, type TestConfig } from './fakes.js';
import { makeTemplate } from './helpers.js';

function createInput(key: string): ManagedTemplateCreateInput {
  return {
    key,
    name: key,
    description: '',
    templateManagedBackend: 'in-memory',
    bodyTemplate: 'body',
    subjectTemplate: null,
    preheaderTemplate: null,
    tenant: null,
  };
}

function makeService(
  backend: BaseTemplateManagerBackend,
  options: { allowDeletingPublishedVersions?: boolean } = {},
): ManagedTemplateService<TestConfig, { subject: string; body: string }> {
  return new ManagedTemplateService(backend, makeManagedEmailRenderer(backend).renderer, options);
}

let backend: InMemoryTemplateManagerBackend;
let service: ManagedTemplateService<TestConfig, { subject: string; body: string }>;

beforeEach(() => {
  backend = new InMemoryTemplateManagerBackend();
  service = makeService(backend);
});

describe('deleting through the service', () => {
  it('deletes a draft that was never published', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k');
    await service.updateTemplate('k', {});

    await service.deleteTemplate('k', 2);

    expect((await service.getTemplate('k')).version).toBe(1);
  });

  it('refuses to delete an active version', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k');

    await expect(service.deleteTemplate('k', 1)).rejects.toThrow(
      ManagedTemplateDeletionNotAllowedError,
    );
    expect((await service.getTemplate('k', 1)).status).toBe('active');
  });

  it('refuses to delete the latest version when no version is named and it is published', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k');

    await expect(service.deleteTemplate('k')).rejects.toThrow(
      ManagedTemplateDeletionNotAllowedError,
    );
  });

  it('refuses to delete an inactive or archived version', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k');
    await service.deactivate('k');
    await service.updateTemplate('k', {});
    await service.archive('k', 2);

    await expect(service.deleteTemplate('k', 1)).rejects.toThrow(
      ManagedTemplateDeletionNotAllowedError,
    );
    await expect(service.deleteTemplate('k', 2)).rejects.toThrow(
      ManagedTemplateDeletionNotAllowedError,
    );
  });

  it('refuses a draft whose history shows it was published before', async () => {
    const loose = makeService(backend);
    await loose.createTemplate(createInput('k'));
    await backend.createTemplateStatusUpdate({ templateKey: 'k', version: 1, status: 'active' });
    await backend.createTemplateStatusUpdate({ templateKey: 'k', version: 1, status: 'draft' });

    await expect(loose.deleteTemplate('k', 1)).rejects.toThrow(
      ManagedTemplateDeletionNotAllowedError,
    );
  });

  it('keeps the status history of a version it refused to delete', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1, 'reviewer');

    await expect(service.deleteTemplate('k', 1)).rejects.toThrow();

    expect(await service.getStatusHistory('k', 1)).toMatchObject([
      { status: 'active', changedBy: 'reviewer' },
    ]);
  });

  it('still reports a missing version as not found', async () => {
    await expect(service.deleteTemplate('nope')).rejects.toThrow(ManagedTemplateNotFoundError);
  });

  it('enforces the rule for a backend that does not enforce it itself', async () => {
    const permissive = new InMemoryTemplateManagerBackend({ allowDeletingPublishedVersions: true });
    const strictService = makeService(permissive);
    await strictService.createTemplate(createInput('k'));
    await strictService.activate('k');

    await expect(strictService.deleteTemplate('k', 1)).rejects.toThrow(
      ManagedTemplateDeletionNotAllowedError,
    );
  });

  it('hard-deletes a published version only when both service and backend opt in', async () => {
    const permissive = new InMemoryTemplateManagerBackend({ allowDeletingPublishedVersions: true });
    const permissiveService = makeService(permissive, { allowDeletingPublishedVersions: true });
    await permissiveService.createTemplate(createInput('k'));
    await permissiveService.activate('k', 1, 'reviewer');
    await permissiveService.updateTemplate('k', {});

    await permissiveService.deleteTemplate('k', 1);

    await expect(permissiveService.getTemplate('k', 1)).rejects.toThrow(
      ManagedTemplateNotFoundError,
    );
    // The audit trail outlives the version it describes.
    expect(await permissive.getTemplateStatusHistory('k', 1)).toMatchObject([
      { version: 1, status: 'active', changedBy: 'reviewer' },
    ]);
  });
});

describe('deleting through the in-memory backend directly', () => {
  it('refuses a published version by default', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k');

    await expect(backend.deleteTemplate('k', 1)).rejects.toThrow(
      ManagedTemplateDeletionNotAllowedError,
    );
  });

  it('deletes a never-published draft', async () => {
    await service.createTemplate(createInput('k'));

    await backend.deleteTemplate('k', 1);

    await expect(backend.getTemplate('k')).rejects.toThrow(ManagedTemplateNotFoundError);
  });
});

describe('isTemplateVersionDeletable', () => {
  const history = (status: 'draft' | 'active' | 'inactive' | 'archived') => ({
    templateKey: 'k',
    version: 1,
    status,
    createdAt: new Date(),
    changedBy: null,
    tenant: null,
  });

  it('allows a draft with no history, or only its creation', () => {
    expect(isTemplateVersionDeletable(makeTemplate('k', '', { status: 'draft' }), [])).toBe(true);
    expect(
      isTemplateVersionDeletable(makeTemplate('k', '', { status: 'draft' }), [history('draft')]),
    ).toBe(true);
  });

  it('refuses anything that is not a draft, or was ever anything else', () => {
    expect(isTemplateVersionDeletable(makeTemplate('k', '', { status: 'active' }), [])).toBe(false);
    expect(
      isTemplateVersionDeletable(makeTemplate('k', '', { status: 'draft' }), [
        history('draft'),
        history('active'),
        history('draft'),
      ]),
    ).toBe(false);
  });
});
