import type {
  AnyNotification,
  BaseLogger,
  BaseNotificationTemplateRenderer,
  EmailTemplate,
  JsonObject,
} from 'vintasend';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ManagedTemplateCompositionReferenceError,
  ManagedTemplateNotFoundError,
} from '../errors.js';
import { InMemoryTemplateManagerBackend } from '../in-memory-template-manager-backend.js';
import {
  ManagedTemplateEmailRenderer,
  type ManagedTemplateFallbackOptions,
  ManagedTemplateTextRenderer,
} from '../managed-template-renderer.js';
import { ManagedTemplateService } from '../managed-template-service.js';
import type { ManagedTemplateCreateInput } from '../types.js';
import { makeNotification, RecordingEmailRenderer, type TestConfig } from './fakes.js';

function createInput(
  key: string,
  overrides: Partial<ManagedTemplateCreateInput> = {},
): ManagedTemplateCreateInput {
  return {
    key,
    name: key,
    description: '',
    templateManagedBackend: 'in-memory',
    bodyTemplate: 'stored {name}',
    subjectTemplate: 'Stored subject',
    preheaderTemplate: null,
    tenant: null,
    ...overrides,
  };
}

/** A file renderer stand-in: records which notification it was asked to render. */
class RecordingFileRenderer implements BaseNotificationTemplateRenderer<TestConfig, EmailTemplate> {
  readonly notifications: AnyNotification<TestConfig>[] = [];

  readonly contexts: JsonObject[] = [];

  async render(notification: AnyNotification<TestConfig>, context: JsonObject) {
    this.notifications.push(notification);
    this.contexts.push(context);
    return {
      subject: `file:${notification.subjectTemplate}`,
      body: `file:${notification.bodyTemplate}`,
    };
  }

  async renderFromTemplateContent(): Promise<EmailTemplate> {
    throw new Error('A fallback render goes through render(), never renderFromTemplateContent().');
  }
}

class RecordingLogger implements BaseLogger {
  readonly lines: string[] = [];

  info(message: string): void {
    this.lines.push(message);
  }

  warn(message: string): void {
    this.lines.push(message);
  }

  error(message: string): void {
    this.lines.push(message);
  }
}

const FALLBACK_TEMPLATES = {
  welcome: { subjectTemplate: 'emails/welcome.subject.pug', bodyTemplate: 'emails/welcome.pug' },
};

let backend: InMemoryTemplateManagerBackend;
let service: ManagedTemplateService<TestConfig, EmailTemplate>;
let fileRenderer: RecordingFileRenderer;

function makeRenderer(
  fallback: ManagedTemplateFallbackOptions<TestConfig, EmailTemplate> | undefined = {
    renderer: fileRenderer,
    templates: FALLBACK_TEMPLATES,
  },
): ManagedTemplateEmailRenderer<TestConfig> {
  return new ManagedTemplateEmailRenderer<TestConfig>(backend, new RecordingEmailRenderer(), {
    fallback,
  });
}

beforeEach(() => {
  backend = new InMemoryTemplateManagerBackend();
  fileRenderer = new RecordingFileRenderer();
  service = new ManagedTemplateService(backend, makeRenderer());
});

describe('a key with nothing stored', () => {
  it('renders the registered default through the fallback renderer', async () => {
    const renderer = makeRenderer();

    const rendered = await renderer.render(makeNotification('welcome'), { name: 'Ana' });

    expect(rendered).toEqual({
      subject: 'file:emails/welcome.subject.pug',
      body: 'file:emails/welcome.pug',
      templateSource: 'fallback',
    });
    expect(fileRenderer.notifications[0]?.bodyTemplate).toBe('emails/welcome.pug');
    expect(fileRenderer.contexts[0]).toEqual({ name: 'Ana' });
  });

  it('reports no templateVersion, so usedTemplateVersion stays null', async () => {
    const rendered = await makeRenderer().render(makeNotification('welcome'), {});

    expect(rendered).not.toHaveProperty('templateVersion');
  });

  it('defaults the fallback renderer to the inner renderer', async () => {
    const inner = new RecordingFileRenderer();
    const renderer = new ManagedTemplateEmailRenderer<TestConfig>(backend, inner, {
      fallback: { templates: FALLBACK_TEMPLATES },
    });

    const rendered = await renderer.render(makeNotification('welcome'), {});

    expect(rendered.body).toBe('file:emails/welcome.pug');
  });

  it('does not mutate the notification it was given', async () => {
    const notification = makeNotification('welcome');

    await makeRenderer().render(notification, {});

    expect(notification.bodyTemplate).toBe('welcome');
  });

  it('throws for a key with no registered default', async () => {
    await expect(makeRenderer().render(makeNotification('other'), {})).rejects.toThrow(
      ManagedTemplateNotFoundError,
    );
  });

  it('throws when no fallback is configured at all', async () => {
    const renderer = new ManagedTemplateEmailRenderer<TestConfig>(
      backend,
      new RecordingEmailRenderer(),
    );

    await expect(renderer.render(makeNotification('welcome'), {})).rejects.toThrow(
      ManagedTemplateNotFoundError,
    );
  });

  it('never matches a key through the prototype', async () => {
    await expect(makeRenderer().render(makeNotification('constructor'), {})).rejects.toThrow(
      ManagedTemplateNotFoundError,
    );
    await expect(makeRenderer().render(makeNotification('toString'), {})).rejects.toThrow(
      ManagedTemplateNotFoundError,
    );
  });

  it('logs the key and the notification id, never the context', async () => {
    const renderer = makeRenderer();
    const logger = new RecordingLogger();
    renderer.injectLogger(logger);

    await renderer.render(makeNotification('welcome'), { name: 'Sensitive Name' });

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain('welcome');
    expect(logger.lines[0]).toContain('notification-1');
    expect(logger.lines.join('\n')).not.toContain('Sensitive Name');
  });
});

describe('a key with only a draft', () => {
  it('counts as not customized yet and renders the default', async () => {
    await service.createTemplate(createInput('welcome'));

    const rendered = await makeRenderer().render(makeNotification('welcome'), {});

    expect(rendered.body).toBe('file:emails/welcome.pug');
  });
});

describe('a key with a stored template', () => {
  it('renders the stored one once it is published', async () => {
    await service.createTemplate(createInput('welcome'));
    await service.activate('welcome');

    const rendered = await makeRenderer().render(makeNotification('welcome'), { name: 'Ana' });

    expect(rendered).toMatchObject({ body: 'stored Ana', templateVersion: 1 });
    expect(rendered).not.toHaveProperty('templateSource');
    expect(fileRenderer.notifications).toHaveLength(0);
  });

  it('throws rather than falling back when it extends a missing base', async () => {
    await service.createTemplate(
      createInput('welcome', { bodyTemplate: '{% managed_extends "missing-base" %}hi' }),
    );
    await service.activate('welcome');

    await expect(makeRenderer().render(makeNotification('welcome'), {})).rejects.toThrow(
      ManagedTemplateCompositionReferenceError,
    );
    expect(fileRenderer.notifications).toHaveLength(0);
  });
});

describe('a pinned notification', () => {
  it('throws rather than falling back when its version is missing', async () => {
    await expect(makeRenderer().render(makeNotification('welcome', 3), {})).rejects.toThrow(
      ManagedTemplateNotFoundError,
    );
    expect(fileRenderer.notifications).toHaveLength(0);
  });
});

describe('the paths that never fall back', () => {
  it('getLatestTemplateVersion still answers null for a missing key', async () => {
    expect(await makeRenderer().getLatestTemplateVersion('welcome')).toBeNull();
  });

  it('renderManaged throws for a missing key', async () => {
    await expect(makeRenderer().renderManaged(makeNotification('welcome'), {})).rejects.toThrow(
      ManagedTemplateNotFoundError,
    );
  });

  it('the service render (used by previews) throws for a missing key', async () => {
    await expect(service.render(makeNotification('welcome'), {})).rejects.toThrow(
      ManagedTemplateNotFoundError,
    );
  });
});

describe('getFallbackTemplate', () => {
  it('exposes the registered default for a key', () => {
    expect(makeRenderer().getFallbackTemplate('welcome')).toEqual(FALLBACK_TEMPLATES.welcome);
  });

  it('answers null for an unregistered key, a prototype key, or no fallback at all', () => {
    expect(makeRenderer().getFallbackTemplate('other')).toBeNull();
    expect(makeRenderer().getFallbackTemplate('constructor')).toBeNull();
    const withoutFallback = new ManagedTemplateEmailRenderer<TestConfig>(
      backend,
      new RecordingEmailRenderer(),
    );
    expect(withoutFallback.getFallbackTemplate('welcome')).toBeNull();
  });
});

describe('text channels', () => {
  it('fall back the same way', async () => {
    const fallbackRenderer = {
      render: async (notification: AnyNotification<TestConfig>) => ({
        text: `file:${notification.bodyTemplate}`,
      }),
      renderFromTemplateContent: async () => ({ text: '' }),
    };
    const renderer = new ManagedTemplateTextRenderer<TestConfig>(
      backend,
      fallbackRenderer as never,
      { fallback: { templates: { sms: { subjectTemplate: null, bodyTemplate: 'sms/code.pug' } } } },
    );

    const rendered = await renderer.render(makeNotification('sms'), {});

    expect(rendered).toEqual({ text: 'file:sms/code.pug', templateSource: 'fallback' });
  });
});
