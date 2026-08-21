import type {
  AnyNotification,
  BaseNotificationTemplateRenderer,
  ContextGenerator,
  EmailTemplate,
  JsonObject,
} from 'vintasend';

import {
  type ManagedEmailTemplateContent,
  ManagedTemplateEmailRenderer,
} from '../managed-template-renderer.js';

export type TestConfig = {
  ContextMap: Record<string, ContextGenerator>;
  NotificationIdType: string;
  UserIdType: string;
};

/**
 * An email renderer that interpolates `{name}`-style placeholders and records what it was fed.
 *
 * Deliberately trivial: the tests here are about which template reached the engine and in what
 * shape, not about any engine's syntax.
 */
export class RecordingEmailRenderer
  implements BaseNotificationTemplateRenderer<TestConfig, EmailTemplate>
{
  readonly contents: ManagedEmailTemplateContent[] = [];

  async renderFromTemplateContent(
    _notification: AnyNotification<TestConfig>,
    templateContent: ManagedEmailTemplateContent,
    context: JsonObject,
  ): Promise<EmailTemplate> {
    this.contents.push(templateContent);
    return {
      subject: interpolate(templateContent.subject ?? '', context),
      body: interpolate(templateContent.body, context),
    };
  }

  async render(): Promise<EmailTemplate> {
    throw new Error('The managed renderer never calls the inner renderer through render().');
  }
}

function interpolate(source: string, context: JsonObject): string {
  return source.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = context[key];
    return value === undefined ? whole : String(value);
  });
}

export function makeManagedEmailRenderer(
  backend: ConstructorParameters<typeof ManagedTemplateEmailRenderer>[0],
): {
  renderer: ManagedTemplateEmailRenderer<TestConfig>;
  inner: RecordingEmailRenderer;
} {
  const inner = new RecordingEmailRenderer();
  return { renderer: new ManagedTemplateEmailRenderer<TestConfig>(backend, inner), inner };
}

/** A notification carrying just the fields a managed renderer reads. */
export function makeNotification(
  bodyTemplate: string,
  requestedTemplateVersion: number | null = null,
): AnyNotification<TestConfig> {
  return {
    id: 'notification-1',
    userId: 'user-1',
    notificationType: 'EMAIL',
    title: 'Hi',
    bodyTemplate,
    contextName: 'test',
    contextParameters: {},
    sendAfter: null,
    subjectTemplate: null,
    extraParams: null,
    requestedTemplateVersion,
  } as unknown as AnyNotification<TestConfig>;
}
