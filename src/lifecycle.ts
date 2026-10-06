/**
 * The two lifecycle rules every backend has to agree on: which version a send renders, and which
 * versions may be deleted.
 *
 * Both live here rather than in one backend so the in-memory store, a FHIR store and the service
 * apply the same rule, and so a backend author has a function to call instead of prose to
 * re-derive.
 *
 * **Which version a send renders.** "The latest version" means two different things, and the
 * seam keeps them apart:
 *
 * * The *editing view* — `getTemplate(key)` with no version — is the newest version whatever its
 *   status. An editor or an API listing a key's history wants the draft someone is working on.
 * * The *send path* — {@link resolveActiveTemplate} — is the newest `active` version. A draft is
 *   unreviewed by definition, so publishing is the deliberate act that puts a version in front of
 *   recipients. When several versions are active at once (the lifecycle allows it), the
 *   highest-numbered one wins.
 *
 * **Which versions may be deleted.** Only one that was never published — see
 * {@link isTemplateVersionDeletable}.
 */

import type { BaseTemplateManagerBackend } from './base-template-manager-backend.js';
import {
  ManagedTemplateDeletionNotAllowedError,
  ManagedTemplateNoActiveVersionError,
} from './errors.js';
import type { ManagedTemplate, ManagedTemplateStatusHistory } from './types.js';

/**
 * The highest-numbered `active` version among `versions`, or `undefined` when none is active.
 *
 * `versions` may hold several keys' rows; the caller narrows it to one key first.
 */
export function newestActiveVersion(
  versions: readonly ManagedTemplate[],
): ManagedTemplate | undefined {
  return versions.reduce<ManagedTemplate | undefined>(
    (newest, template) =>
      template.status === 'active' && (newest === undefined || template.version > newest.version)
        ? template
        : newest,
    undefined,
  );
}

/**
 * The version an unpinned send of `templateKey` renders: its highest-numbered `active` version.
 *
 * Uses the backend's own `getActiveTemplate` when it has one. A backend written before that method
 * existed is answered through the filter seam instead — an exact key match plus `status: 'active'`
 * — which every backend supports by default.
 *
 * @throws ManagedTemplateNotFoundError if the key does not exist.
 * @throws ManagedTemplateNoActiveVersionError if it exists but no version of it is active.
 */
export async function resolveActiveTemplate(
  backend: BaseTemplateManagerBackend,
  templateKey: string,
): Promise<ManagedTemplate> {
  if (typeof backend.getActiveTemplate === 'function') {
    return backend.getActiveTemplate(templateKey);
  }

  const active = newestActiveVersion(
    await backend.getFilteredTemplates({ key: templateKey, status: 'active' }),
  );
  if (active !== undefined && active.key === templateKey) {
    return active;
  }
  // Tells "never created" apart from "nothing published": this read throws the plain not-found
  // error for a key with no versions at all.
  await backend.getTemplate(templateKey, null);
  throw noActiveVersion(templateKey);
}

/** The error a backend throws for a key that exists but has no `active` version. */
export function noActiveVersion(templateKey: string): ManagedTemplateNoActiveVersionError {
  return new ManagedTemplateNoActiveVersionError(
    `Template '${templateKey}' has no active version. Activate a version before sending it.`,
  );
}

/**
 * Whether a template version may be hard-deleted: it was never published.
 *
 * That means it is still in `draft` and its status history records nothing but `draft` — a
 * backend that writes a creation entry is fine, and one that writes none is too. A version that
 * was ever `active`, `inactive` or `archived` may have rendered a notification that is pinned to
 * it, and its history is the record of who published it; retire it with `archive` instead.
 */
export function isTemplateVersionDeletable(
  template: ManagedTemplate,
  history: readonly ManagedTemplateStatusHistory[],
): boolean {
  return (
    template.status === 'draft' &&
    history
      .filter(
        (record) => record.templateKey === template.key && record.version === template.version,
      )
      .every((record) => record.status === 'draft')
  );
}

/**
 * Throw unless {@link isTemplateVersionDeletable} allows deleting `template`.
 *
 * @throws ManagedTemplateDeletionNotAllowedError
 */
export function assertTemplateVersionDeletable(
  template: ManagedTemplate,
  history: readonly ManagedTemplateStatusHistory[],
): void {
  if (isTemplateVersionDeletable(template, history)) {
    return;
  }
  throw new ManagedTemplateDeletionNotAllowedError(
    `Template '${template.key}' v${template.version} has been published and cannot be deleted. ` +
      'Only a draft that was never published can be deleted; archive this version instead.',
  );
}
