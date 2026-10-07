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
 *
 * ## Which version a send renders
 *
 * A notification pinned to a version (`requestedTemplateVersion`) renders that version, whatever
 * its status today — the pin exists so a notification renders what was reviewed when it was
 * created, and deactivating the version later does not change that. An unpinned notification
 * renders the key's newest **active** version: drafts are never sent, and when several versions
 * are active the highest-numbered one wins. A key with no active version has nothing to send.
 *
 * ## Falling back to a default that ships with the app
 *
 * An application can send a notification before anyone has written its template in the store.
 * Register a default per key under the `fallback` option and, while the key has nothing published,
 * `render` hands the default to a renderer of your choosing — a file-based one, typically:
 *
 * ```ts
 * new ManagedTemplateEmailRenderer(backend, new PugEmailTemplateRendererFactory().create(), {
 *   fallback: {
 *     templates: {
 *       welcome: { subjectTemplate: 'emails/welcome.subject.pug', bodyTemplate: 'emails/welcome.pug' },
 *     },
 *   },
 * });
 * ```
 *
 * The fallback applies only to `render` (the send path), only to an unpinned notification, only
 * when the key itself has nothing published — not when a stored template fails to compose — and
 * only to a registered key. Once a version of the key is activated, sends use it.
 */

import {
  type AnyNotification,
  type BaseLogger,
  type BaseNotificationTemplateRenderer,
  type BaseNotificationTypeConfig,
  type EmailTemplate,
  type EmailTemplateContent,
  type JsonObject,
  log,
  logId,
  logLabel,
} from 'vintasend';

import type { BaseTemplateManagerBackend } from './base-template-manager-backend.js';
import { TemplateComposer, type TemplateComposerOptions } from './composition.js';
import { ManagedTemplateNotFoundError } from './errors.js';
import { resolveActiveTemplate } from './lifecycle.js';
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

/**
 * The default a key renders while nothing is published under it.
 *
 * The values are whatever the fallback renderer's `render` expects in a notification's template
 * fields — file paths for a file-based renderer such as `PugEmailTemplateRenderer`, keys for one
 * that looks templates up by name. This package never reads them.
 */
export type ManagedTemplateFallbackTemplate = {
  subjectTemplate: string | null;
  bodyTemplate: string;
};

export type ManagedTemplateFallbackOptions<
  Config extends BaseNotificationTypeConfig,
  RenderedType,
> = {
  /**
   * What renders a default. Its `render` is handed a copy of the notification whose
   * `bodyTemplate` and `subjectTemplate` are replaced by the registered values. Defaults to the
   * inner renderer.
   */
  renderer?: BaseNotificationTemplateRenderer<Config, RenderedType>;
  /** The default per template key. Keys are matched as own properties only. */
  templates: Readonly<Record<string, ManagedTemplateFallbackTemplate>>;
};

export type ManagedTemplateRendererOptions<
  Config extends BaseNotificationTypeConfig = BaseNotificationTypeConfig,
  RenderedType = unknown,
> = {
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
  /**
   * Defaults to send for keys that have nothing published yet. See the module docs for exactly
   * when one is used.
   */
  fallback?: ManagedTemplateFallbackOptions<Config, RenderedType>;
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

  readonly fallback: ManagedTemplateFallbackOptions<Config, RenderedType> | null;

  constructor(
    readonly managerBackend: BaseTemplateManagerBackend,
    readonly renderer: BaseNotificationTemplateRenderer<Config, RenderedType>,
    options: ManagedTemplateRendererOptions<Config, RenderedType> = {},
  ) {
    this.composeTemplates = options.composeTemplates ?? true;
    this.composer =
      options.composer ?? TemplateComposer.fromBackend(managerBackend, options.composerOptions);
    this.fallback = options.fallback ?? null;
  }

  injectLogger(logger: BaseLogger): void {
    this.logger = logger;
    this.renderer.injectLogger?.(logger);
    const fallbackRenderer = this.fallback?.renderer;
    if (fallbackRenderer !== undefined && fallbackRenderer !== this.renderer) {
      fallbackRenderer.injectLogger?.(logger);
    }
  }

  /**
   * The default registered for `templateKey`, or `null` when there is none.
   *
   * For a dashboard: it can show that a key is "using the default", and start the key's first
   * stored version from the default's source.
   */
  getFallbackTemplate(templateKey: string): ManagedTemplateFallbackTemplate | null {
    const templates = this.fallback?.templates;
    if (templates === undefined || !Object.hasOwn(templates, templateKey)) {
      return null;
    }
    return templates[templateKey] ?? null;
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
   * The version a notification created now should be pinned to: the key's newest active version.
   *
   * The same version `render` would resolve to if the notification were left unpinned, so a
   * draft is never pinned. A key with nothing published — no versions, or only drafts and retired
   * ones — answers `null` rather than throwing: a missing template is the send's problem to
   * report, and failing here would fail the *creation* of a notification over a template that
   * might well be published by the time it is sent.
   */
  async getLatestTemplateVersion(templateKey: string): Promise<number | null> {
    try {
      const template = await this.getActiveTemplate(templateKey);
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
   * The key's newest active version — what an unpinned send renders.
   *
   * @throws ManagedTemplateNotFoundError if the key does not exist.
   * @throws ManagedTemplateNoActiveVersionError if no version of it is active.
   */
  async getActiveTemplate(templateKey: string): Promise<ManagedTemplate> {
    return resolveActiveTemplate(this.managerBackend, templateKey);
  }

  /**
   * Render a notification against a specific version of its template, reporting which version
   * was used.
   *
   * The notification's `bodyTemplate` is the template key. Which version renders is decided in
   * this order: the `version` argument, then the notification's own `requestedTemplateVersion`,
   * then the key's newest active version.
   *
   * The argument is there to render a version the notification is *not* pinned to — previewing
   * an unpublished draft, or reproducing what an old notification looked like. Leave it off and
   * this renders what a real send would, except that it never falls back to a registered default:
   * a missing key throws.
   */
  async renderManaged(
    notification: AnyNotification<Config>,
    context: JsonObject,
    version: number | null = null,
  ): Promise<ManagedTemplateRenderResult<RenderedType>> {
    const template = await this.resolveTemplate(
      notification.bodyTemplate,
      version ?? requestedTemplateVersion(notification),
    );
    return this.renderTemplate(notification, template, context);
  }

  /**
   * Render a notification against the version it is pinned to, or the key's newest active one.
   *
   * This is the `BaseNotificationTemplateRenderer` seam VintaSend itself calls, so the rendered
   * payload is all it can return — and the version that produced it is stamped onto that payload
   * as `templateVersion`. That is the channel VintaSend reads: an adapter returns the payload from
   * `send()`, and the service records the version on the notification as `usedTemplateVersion`.
   * On an unpinned notification it is the only record of which version went out, since the
   * template has moved on by the time anyone asks.
   *
   * An unpinned notification whose key has nothing published renders the default registered
   * under `fallback`, when there is one. That payload carries `templateSource: 'fallback'` and no
   * `templateVersion`, so `usedTemplateVersion` stays null.
   *
   * Call {@link renderManaged} instead when driving the render yourself and the version matters.
   */
  async render(notification: AnyNotification<Config>, context: JsonObject): Promise<RenderedType> {
    const pin = requestedTemplateVersion(notification);
    let template: ManagedTemplate;
    try {
      template = await this.resolveTemplate(notification.bodyTemplate, pin);
    } catch (error) {
      // Only the lookup of the notification's own key is guarded. A stored template that fails to
      // compose — a base it extends is missing — throws from `renderTemplate` below and never
      // reaches this branch: that template exists and is broken, which a default must not hide.
      const fallback = pin === null ? this.fallbackFor(notification.bodyTemplate, error) : null;
      if (fallback === null) {
        throw error;
      }
      return this.renderFallback(notification, fallback, context);
    }
    const result = await this.renderTemplate(notification, template, context);
    return withTemplateVersion(result.rendered, result.version);
  }

  /** A pinned version as stored, whatever its status; otherwise the newest active one. */
  private async resolveTemplate(
    templateKey: string,
    version: number | null,
  ): Promise<ManagedTemplate> {
    if (version !== null) {
      return this.managerBackend.getTemplate(templateKey, version);
    }
    return this.getActiveTemplate(templateKey);
  }

  /**
   * The default to render in place of `templateKey`, when the lookup failed because the key has
   * nothing published — `ManagedTemplateNotFoundError`, or its no-active-version subclass.
   */
  private fallbackFor(templateKey: string, error: unknown): ManagedTemplateFallbackTemplate | null {
    if (!(error instanceof ManagedTemplateNotFoundError)) {
      return null;
    }
    return this.getFallbackTemplate(templateKey);
  }

  private async renderFallback(
    notification: AnyNotification<Config>,
    fallback: ManagedTemplateFallbackTemplate,
    context: JsonObject,
  ): Promise<RenderedType> {
    // The key and the notification id only: the context is the recipient's data.
    this.logger?.info(
      log`[ManagedTemplateRenderer] template '${logLabel(notification.bodyTemplate)}' has nothing published; rendering the registered fallback for notification ${logId(notification.id)}.`,
    );
    const renderer = this.fallback?.renderer ?? this.renderer;
    const rendered = await renderer.render(
      {
        ...notification,
        bodyTemplate: fallback.bodyTemplate,
        subjectTemplate: fallback.subjectTemplate,
      } as AnyNotification<Config>,
      context,
    );
    return withFallbackSource(rendered);
  }
}

/**
 * Mark a payload as rendered from a registered default, so a host can tell the default went out.
 *
 * Any `templateVersion` a fallback renderer set is dropped: no stored version rendered, and
 * VintaSend would otherwise record one as `usedTemplateVersion`.
 */
function withFallbackSource<RenderedType>(rendered: RenderedType): RenderedType {
  if (rendered === null || typeof rendered !== 'object') {
    return rendered;
  }
  const { templateVersion: _ignored, ...rest } = rendered as Record<string, unknown>;
  return { ...rest, templateSource: 'fallback' } as RenderedType;
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
