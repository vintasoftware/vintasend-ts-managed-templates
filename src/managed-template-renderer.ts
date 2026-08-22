/**
 * The renderer that feeds a stored template to an ordinary VintaSend renderer.
 *
 * `ManagedTemplateRenderer` wraps another renderer and swaps out where the template comes from:
 * instead of a path an engine's loader resolves, the notification's `bodyTemplate` is a key this
 * package's storage seam looks up. What the inner renderer receives is template *source*, so it
 * has to implement `renderFromTemplateContent` — which every renderer in the VintaSend ecosystem
 * does, because that is the seam VintaSend already uses to render content it holds rather than
 * loads.
 *
 * Templates are composed before they reach the inner renderer. A stored template can extend a
 * base and include shared fragments (see `composition`), and none of that survives into what the
 * engine sees: it gets one flat string. Composition is on by default and can be turned off per
 * renderer with `composeTemplates: false`, which is the right call only if a store predates
 * composition and holds `managed_`-prefixed text meant to be passed through.
 */

import type {
  AnyNotification,
  BaseLogger,
  BaseNotificationTemplateRenderer,
  BaseNotificationTypeConfig,
  EmailTemplate,
  EmailTemplateContent,
  JsonObject,
} from 'vintasend';

import type { BaseTemplateManagerBackend } from './base-template-manager-backend.js';
import { TemplateComposer, type TemplateComposerOptions } from './composition.js';
import { ManagedTemplateNotFoundError } from './errors.js';
import type { ManagedTemplate } from './types.js';

/**
 * A notification that names which version of its template it was recorded against.
 *
 * VintaSend declares `requestedTemplateVersion` on its own notification types, so this is only
 * the shape {@link requestedTemplateVersion} needs — kept exported for a host with a notification
 * type of its own, and for reading a pin off a record that came from somewhere else.
 */
export type VersionPinnedNotification = {
  requestedTemplateVersion?: number | null;
};

/**
 * Read a notification's template-version pin, if it carries one.
 *
 * Takes `unknown` rather than a notification type because it is also pointed at records that
 * predate the field — a backend that never stored it hands back a notification with nothing
 * there, and `null` is the right answer for those rather than a type error.
 */
export function requestedTemplateVersion(notification: unknown): number | null {
  const pin = (notification as VersionPinnedNotification | null)?.requestedTemplateVersion;
  return typeof pin === 'number' ? pin : null;
}

/**
 * What rendering a managed template produced, and which version produced it.
 *
 * `render` also stamps the version onto the rendered payload itself, which is how VintaSend's
 * service picks it up — see {@link ManagedTemplateRenderer.render}. This richer result is for a
 * caller driving the render directly, where reading a documented field beats fishing an optional
 * one off the payload.
 */
export type ManagedTemplateRenderResult<RenderedType> = {
  key: string;
  version: number;
  rendered: RenderedType;
};

/**
 * The email content a managed template produces.
 *
 * `EmailTemplateContent` as VintaSend defines it, plus the preheader managed templates carry.
 * A renderer that knows about preheaders can read it; one that does not ignores the extra field,
 * which is why it is added rather than replacing the shape.
 */
export type ManagedEmailTemplateContent = EmailTemplateContent & {
  preheader: string | null;
};

export type ManagedTemplateRendererOptions = {
  /**
   * When true (the default), `managed_*` inheritance and inclusion tags are resolved before the
   * inner renderer sees the template.
   */
  composeTemplates?: boolean;
  /**
   * The composer to resolve them with. Defaults to one reading through the template manager
   * backend; pass your own to change the tag prefix or the depth limit.
   */
  composer?: TemplateComposer;
  /** Options for the default composer. Ignored when `composer` is given. */
  composerOptions?: TemplateComposerOptions;
};

export abstract class ManagedTemplateRenderer<
  Config extends BaseNotificationTypeConfig,
  RenderedType,
  ContentType,
> implements BaseNotificationTemplateRenderer<Config, RenderedType>
{
  logger: BaseLogger | null = null;

  readonly composeTemplates: boolean;

  readonly composer: TemplateComposer;

  constructor(
    readonly managerBackend: BaseTemplateManagerBackend,
    readonly renderer: BaseNotificationTemplateRenderer<Config, RenderedType>,
    options: ManagedTemplateRendererOptions = {},
  ) {
    this.composeTemplates = options.composeTemplates ?? true;
    this.composer =
      options.composer ?? TemplateComposer.fromBackend(managerBackend, options.composerOptions);
  }

  injectLogger(logger: BaseLogger): void {
    this.logger = logger;
    this.renderer.injectLogger?.(logger);
  }

  /** Build the inner renderer's template content from a stored template. */
  abstract createTemplateContent(template: ManagedTemplate): ContentType;

  /**
   * Resolve a template's composition tags, unless this renderer was told not to.
   *
   * @throws ManagedTemplateCompositionError if the template cannot be assembled.
   */
  async compose(template: ManagedTemplate): Promise<ManagedTemplate> {
    if (!this.composeTemplates) {
      return template;
    }
    return this.composer.compose(template);
  }

  /**
   * The newest version of a stored template, for a host to pin a notification to.
   *
   * Answers with whatever version the backend considers current for that key, which is the same
   * version `render` would resolve to if the notification were left unpinned. A key with nothing
   * behind it answers `null` rather than throwing: a missing template is the send's problem to
   * report, and failing here would fail the *creation* of a notification over a template that
   * might well exist by the time it is sent.
   */
  async getLatestTemplateVersion(templateKey: string): Promise<number | null> {
    try {
      const template = await this.managerBackend.getTemplate(templateKey);
      return template.version;
    } catch (error) {
      if (error instanceof ManagedTemplateNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  renderFromTemplateContent(
    notification: AnyNotification<Config>,
    templateContent: ContentType,
    context: JsonObject,
  ): Promise<RenderedType> {
    return this.renderer.renderFromTemplateContent(notification, templateContent, context);
  }

  /**
   * Render a notification against a template already in hand, with no backend read.
   *
   * The template is composed first, so one already fetched and edited in memory renders the same
   * way a stored one does.
   */
  async renderTemplate(
    notification: AnyNotification<Config>,
    template: ManagedTemplate,
    context: JsonObject,
  ): Promise<ManagedTemplateRenderResult<RenderedType>> {
    const content = this.createTemplateContent(await this.compose(template));
    const rendered = await this.renderFromTemplateContent(notification, content, context);
    return { key: template.key, version: template.version, rendered };
  }

  /**
   * Render a notification against a specific version of its template, reporting which version
   * was used.
   *
   * The notification's `bodyTemplate` is the template key. Which version renders is decided in
   * this order: the `version` argument, then the notification's own `requestedTemplateVersion`,
   * then whatever the backend considers current.
   *
   * The argument is there to render a version the notification is *not* pinned to — previewing
   * an unpublished draft, or reproducing what an old notification looked like. Leave it off and
   * this renders what a real send would.
   */
  async renderManaged(
    notification: AnyNotification<Config>,
    context: JsonObject,
    version: number | null = null,
  ): Promise<ManagedTemplateRenderResult<RenderedType>> {
    const resolved = version ?? requestedTemplateVersion(notification);
    const template = await this.managerBackend.getTemplate(notification.bodyTemplate, resolved);
    return this.renderTemplate(notification, template, context);
  }

  /**
   * Render a notification against the version it is pinned to, or the current one.
   *
   * This is the `BaseNotificationTemplateRenderer` seam VintaSend itself calls, so the rendered
   * payload is all it can return — and the version that produced it is stamped onto that payload
   * as `templateVersion`. That is the channel VintaSend reads: an adapter returns the payload from
   * `send()`, and the service records the version on the notification as `usedTemplateVersion`.
   * On an unpinned notification it is the only record of which version went out, since the
   * template has moved on by the time anyone asks.
   *
   * Call {@link renderManaged} instead when driving the render yourself and the version matters.
   */
  async render(notification: AnyNotification<Config>, context: JsonObject): Promise<RenderedType> {
    const result = await this.renderManaged(notification, context);
    return withTemplateVersion(result.rendered, result.version);
  }
}

/**
 * Stamp the version that rendered onto the payload, without mutating what the inner renderer
 * returned.
 *
 * A renderer producing something that is not an object — nothing shipped does, but the seam is
 * generic — is handed back untouched rather than wrapped, since there is nowhere to put the field
 * and losing the payload would be the worse trade.
 */
function withTemplateVersion<RenderedType>(rendered: RenderedType, version: number): RenderedType {
  if (rendered === null || typeof rendered !== 'object') {
    return rendered;
  }
  return { ...rendered, templateVersion: version };
}

/** A managed-template renderer for email, feeding subject, body and preheader downstream. */
export class ManagedTemplateEmailRenderer<
  Config extends BaseNotificationTypeConfig,
> extends ManagedTemplateRenderer<Config, EmailTemplate, ManagedEmailTemplateContent> {
  createTemplateContent(template: ManagedTemplate): ManagedEmailTemplateContent {
    return {
      subject: template.subjectTemplate,
      body: template.bodyTemplate,
      preheader: template.preheaderTemplate,
    };
  }
}

/** The rendered payload of a text-only channel, as VintaSend's text renderers produce it. */
export type TextTemplate = { text: string };

/** The content a text-only renderer is fed. */
export type TextTemplateContent = { text: string };

/** A managed-template renderer for SMS and other text-only channels. */
export class ManagedTemplateTextRenderer<
  Config extends BaseNotificationTypeConfig,
> extends ManagedTemplateRenderer<Config, TextTemplate, TextTemplateContent> {
  createTemplateContent(template: ManagedTemplate): TextTemplateContent {
    return { text: template.bodyTemplate };
  }
}
