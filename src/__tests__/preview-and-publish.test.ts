/**
 * Previewing and publishing without a notification, and "the version new emails get".
 *
 * Parts named without `version=` resolve two ways: an editor previews the newest version of each,
 * drafts included, and a send renders the newest published one. These tests hold the library to
 * that split without a host wiring two composers, and hold publishing to "it renders, or nothing
 * is written".
 */

import {
  type AnyNotification,
  type EmailTemplate,
  type JsonObject,
  NotificationActionError,
  VintaSendFactory,
} from 'vintasend';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ManagedTemplateCompositionReferenceError,
  ManagedTemplateRenderCheckError,
  ManagedTemplateStatusTransitionError,
} from '../errors.js';
import { InMemoryTemplateManagerBackend } from '../in-memory-template-manager-backend.js';
import {
  type ManagedEmailTemplateContent,
  ManagedTemplateEmailRenderer,
} from '../managed-template-renderer.js';
import { ManagedTemplateService } from '../managed-template-service.js';
import type { ManagedTemplateCreateInput } from '../types.js';
import { makeNotification, RecordingEmailRenderer, type TestConfig } from './fakes.js';

/** Records the notification it was handed, and fails on a body containing `BOOM`. */
class StrictEmailRenderer extends RecordingEmailRenderer {
  readonly notifications: AnyNotification<TestConfig>[] = [];

  override async renderFromTemplateContent(
    notification: AnyNotification<TestConfig>,
    content: ManagedEmailTemplateContent,
    context: JsonObject,
  ): Promise<EmailTemplate> {
    this.notifications.push(notification);
    if (content.body.includes('BOOM')) {
      throw new SyntaxError(`engine choked rendering for ${JSON.stringify(context)}`);
    }
    return super.renderFromTemplateContent(notification, content, context);
  }
}

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
    subjectTemplate: null,
    preheaderTemplate: null,
    tenant: null,
    ...overrides,
  };
}

let backend: InMemoryTemplateManagerBackend;
let inner: StrictEmailRenderer;
let renderer: ManagedTemplateEmailRenderer<TestConfig>;
let service: ManagedTemplateService<TestConfig, EmailTemplate, ManagedEmailTemplateContent>;

beforeEach(() => {
  backend = new InMemoryTemplateManagerBackend();
  inner = new StrictEmailRenderer();
  renderer = new ManagedTemplateEmailRenderer<TestConfig>(backend, inner);
  service = new ManagedTemplateService(backend, renderer);
});

/** `base` v1 published, v2 a draft someone is editing; `welcome` v1 extends it, unpinned. */
async function seedBaseWithDraft() {
  await service.createTemplate(
    createInput('base', { bodyTemplate: '[v1 {% managed_children %}]' }),
  );
  await service.activate('base', 1);
  await service.updateTemplate('base', { bodyTemplate: '[v2 draft {% managed_children %}]' });
  await service.createTemplate(
    createInput('welcome', { bodyTemplate: '{% managed_extends "base" %}Hi {name}' }),
  );
}

describe('sends compose parts as published', () => {
  it('renders a part at its newest published version, not a newer draft', async () => {
    await seedBaseWithDraft();
    await service.activate('welcome', 1);

    const rendered = await renderer.render(makeNotification('welcome'), { name: 'Ana' });

    expect(rendered.body).toBe('[v1 Hi Ana]');
  });

  it('fails a send whose part has nothing published', async () => {
    await service.createTemplate(createInput('base', { bodyTemplate: '[{% managed_children %}]' }));
    await service.createTemplate(
      createInput('welcome', { bodyTemplate: '{% managed_extends "base" %}Hi' }),
    );
    await service.activate('welcome', 1);

    await expect(renderer.render(makeNotification('welcome'), {})).rejects.toThrow(
      ManagedTemplateCompositionReferenceError,
    );
  });

  it("composes against drafts again with composerOptions parts: 'latest'", async () => {
    await seedBaseWithDraft();
    await service.activate('welcome', 1);
    const latest = new ManagedTemplateEmailRenderer<TestConfig>(backend, inner, {
      composerOptions: { parts: 'latest' },
    });

    const rendered = await latest.render(makeNotification('welcome'), { name: 'Ana' });

    expect(rendered.body).toBe('[v2 draft Hi Ana]');
  });

  it('still honours a part pinned with version=', async () => {
    await seedBaseWithDraft();
    await service.updateTemplate('welcome', {
      bodyTemplate: '{% managed_extends "base" version=2 %}Hi {name}',
    });
    await service.activate('welcome', 2);

    const rendered = await renderer.render(makeNotification('welcome'), { name: 'Ana' });

    expect(rendered.body).toBe('[v2 draft Hi Ana]');
  });
});

describe('renderStandalone', () => {
  it("previews drafts with 'latest' and sends with 'published', from one service", async () => {
    await seedBaseWithDraft();
    const welcome = await service.getTemplate('welcome');

    const preview = await service.renderStandalone(welcome, { name: 'Ana' }, { parts: 'latest' });
    const asSent = await service.renderStandalone(welcome, { name: 'Ana' }, { parts: 'published' });

    expect(preview).toEqual({
      key: 'welcome',
      version: 1,
      rendered: { subject: '', body: '[v2 draft Hi Ana]' },
    });
    expect(asSent.rendered.body).toBe('[v1 Hi Ana]');
  });

  it('renders the same from the renderer', async () => {
    await seedBaseWithDraft();
    const welcome = await service.getTemplate('welcome');

    const preview = await renderer.renderStandalone(welcome, { name: 'Ana' }, { parts: 'latest' });
    const asSent = await renderer.renderStandalone(
      welcome,
      { name: 'Ana' },
      { parts: 'published' },
    );

    expect(preview.rendered.body).toBe('[v2 draft Hi Ana]');
    expect(asSent.rendered.body).toBe('[v1 Hi Ana]');
  });

  it('renders an edited copy that was never saved', async () => {
    await seedBaseWithDraft();
    const welcome = await service.getTemplate('welcome');

    const preview = await service.renderStandalone(
      { ...welcome, bodyTemplate: '{% managed_extends "base" %}Bye {name}' },
      { name: 'Ana' },
      { parts: 'published' },
    );

    expect(preview.rendered.body).toBe('[v1 Bye Ana]');
  });

  it('hands the inner renderer a placeholder with no notification in it', async () => {
    await service.createTemplate(createInput('welcome'));
    const welcome = await service.getTemplate('welcome');

    await service.renderStandalone(welcome, { name: 'Ana' }, { parts: 'latest' });

    expect(inner.notifications[0]).toMatchObject({
      id: null,
      bodyTemplate: 'welcome',
      requestedTemplateVersion: 1,
    });
    expect(inner.notifications[0]).not.toHaveProperty('userId');
  });

  it('hands the stored source through when the service does not compose', async () => {
    await seedBaseWithDraft();
    const verbatim = new ManagedTemplateService(backend, renderer, { composeTemplates: false });

    const preview = await verbatim.renderStandalone(
      await service.getTemplate('welcome'),
      { name: 'Ana' },
      { parts: 'published' },
    );

    expect(preview.rendered.body).toBe('{% managed_extends "base" %}Hi Ana');
  });
});

describe('activate with checkRender', () => {
  it('activates a version that renders, and records it', async () => {
    await seedBaseWithDraft();

    const activated = await service.activate('welcome', 1, 'editor-1', {
      checkRender: { context: { name: 'Ana' } },
    });

    expect(activated.status).toBe('active');
    expect(await service.getStatusHistory('welcome', 1)).toEqual([
      expect.objectContaining({ status: 'active', changedBy: 'editor-1' }),
    ]);
  });

  it('checks against published parts: a part with only drafts fails, writing nothing', async () => {
    await service.createTemplate(createInput('base', { bodyTemplate: '[{% managed_children %}]' }));
    await service.createTemplate(
      createInput('welcome', { bodyTemplate: '{% managed_extends "base" %}Hi' }),
    );
    // The editor's preview renders fine, because it composes the draft base.
    await service.renderStandalone(await service.getTemplate('welcome'), {}, { parts: 'latest' });
    const write = vi.spyOn(backend, 'createTemplateStatusUpdate');

    const error = await service
      .activate('welcome', 1, null, { checkRender: { context: {} } })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ManagedTemplateRenderCheckError);
    expect((error as ManagedTemplateRenderCheckError).cause).toBeInstanceOf(
      ManagedTemplateCompositionReferenceError,
    );
    expect(write).not.toHaveBeenCalled();
    expect((await service.getTemplate('welcome', 1)).status).toBe('draft');
    expect(await service.getStatusHistory('welcome', 1)).toEqual([]);
  });

  it('ignores a broken draft of a part, since a send would not render it', async () => {
    await seedBaseWithDraft();
    await service.updateTemplate('base', { bodyTemplate: '{% managed_nonsense %}' });

    const activated = await service.activate('welcome', 1, null, {
      checkRender: { context: { name: 'Ana' } },
    });

    expect(activated.status).toBe('active');
  });

  it('refuses a version the engine cannot render, without its context in the message', async () => {
    await service.createTemplate(createInput('welcome', { bodyTemplate: 'BOOM {name}' }));
    const write = vi.spyOn(backend, 'createTemplateStatusUpdate');

    const error = (await service
      .activate('welcome', 1, null, { checkRender: { context: { name: 'Patient Name' } } })
      .catch((thrown: unknown) => thrown)) as ManagedTemplateRenderCheckError;

    expect(error).toBeInstanceOf(ManagedTemplateRenderCheckError);
    expect(error.templateKey).toBe('welcome');
    expect(error.version).toBe(1);
    expect(error.cause).toBeInstanceOf(SyntaxError);
    expect(error.message).toBe(
      "Template 'welcome' v1 failed its render check (SyntaxError), so it was not activated.",
    );
    expect(write).not.toHaveBeenCalled();
    expect((await service.getTemplate('welcome', 1)).status).toBe('draft');
  });

  it('takes the check through setStatus too', async () => {
    await service.createTemplate(createInput('welcome', { bodyTemplate: 'BOOM' }));

    await expect(
      service.setStatus('welcome', 'active', 1, null, { checkRender: { context: {} } }),
    ).rejects.toThrow(ManagedTemplateRenderCheckError);
    expect((await service.getTemplate('welcome', 1)).status).toBe('draft');
  });

  it('refuses checkRender on a move to anything but active, before reading', async () => {
    await service.createTemplate(createInput('welcome'));
    await service.activate('welcome', 1);
    const read = vi.spyOn(backend, 'getTemplate');
    const write = vi.spyOn(backend, 'createTemplateStatusUpdate');

    await expect(
      service.setStatus('welcome', 'inactive', 1, null, { checkRender: { context: {} } }),
    ).rejects.toThrow(TypeError);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect((await service.getTemplate('welcome', 1)).status).toBe('active');
  });

  it('refuses a disallowed transition before rendering', async () => {
    await service.createTemplate(createInput('welcome', { bodyTemplate: 'BOOM' }));
    await service.archive('welcome', 1);

    await expect(
      service.activate('welcome', 1, null, { checkRender: { context: {} } }),
    ).rejects.toThrow(ManagedTemplateStatusTransitionError);
    expect(inner.notifications).toEqual([]);
  });
});

describe('getCurrentTemplateVersion', () => {
  it('is null until something is published, then the newest active version', async () => {
    await service.createTemplate(createInput('welcome'));
    expect(await service.getCurrentTemplateVersion('welcome')).toBeNull();
    expect(await service.getCurrentTemplateVersion('missing')).toBeNull();

    await service.activate('welcome', 1);
    await service.updateTemplate('welcome', { bodyTemplate: 'draft' });

    expect(await service.getCurrentTemplateVersion('welcome')).toBe(1);
    expect(await renderer.getCurrentTemplateVersion('welcome')).toBe(1);
    expect(await renderer.getLatestTemplateVersion('welcome')).toBe(1);
  });

  it('is null for a base, which is built on rather than sent', async () => {
    await service.createTemplate(createInput('base', { bodyTemplate: '[{% managed_children %}]' }));
    await service.activate('base', 1);

    expect(await service.getCurrentTemplateVersion('base')).toBeNull();
  });

  it('is what VintaSend re-pins to when no version is given', async () => {
    await seedBaseWithDraft();
    await service.activate('welcome', 1);
    await service.updateTemplate('welcome', { bodyTemplate: '{% managed_extends "base" %}v2' });
    await service.activate('welcome', 2);

    const pinned = await repinThroughVintaSend('welcome');
    const basePin = repinThroughVintaSend('base');

    expect(pinned).toBe(await service.getCurrentTemplateVersion('welcome'));
    expect(pinned).toBe(2);
    await expect(basePin).rejects.toBeInstanceOf(NotificationActionError);
    await expect(basePin).rejects.toMatchObject({ reason: 'NO_TEMPLATE_VERSION' });
  });
});

/** Re-pin a pending notification on `templateKey` through VintaSend, returning the new pin. */
async function repinThroughVintaSend(templateKey: string): Promise<number | null | undefined> {
  const notification = {
    ...(makeNotification(templateKey, 1) as object),
    status: 'PENDING_SEND',
  };
  const notificationBackend = {
    getNotification: vi.fn().mockResolvedValue(notification),
    getOneOffNotification: vi.fn().mockResolvedValue(null),
    persistNotificationUpdate: vi
      .fn()
      .mockImplementation(async (_id: unknown, update: object) => ({ ...notification, ...update })),
    getBackendIdentifier: () => 'notifications',
  };
  const adapter = {
    notificationType: 'EMAIL',
    key: 'email',
    enqueueNotifications: false,
    send: vi.fn(),
    injectBackend: vi.fn(),
    injectLogger: vi.fn(),
    getTemplateRenderer: () => renderer,
    supportsAttachments: false,
  };
  const vintasend = new VintaSendFactory<TestConfig>().create({
    adapters: [adapter as never],
    backend: notificationBackend as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    contextGeneratorsMap: {},
  });
  const repinned = await vintasend.repinNotification('notification-1');
  return repinned.requestedTemplateVersion;
}
