import { ManagedTemplateNotFoundError } from '../errors.js';
import type { ManagedTemplate } from '../types.js';

export function makeTemplate(
  key: string,
  body = '',
  overrides: Partial<ManagedTemplate> = {},
): ManagedTemplate {
  const version = overrides.version ?? 1;
  return {
    id: `${key}-${version}`,
    key,
    version,
    name: key,
    description: '',
    templateManagedBackend: 'in-memory',
    bodyTemplate: body,
    subjectTemplate: null,
    preheaderTemplate: null,
    status: 'active',
    tenant: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    tags: [],
    isAbstract: false,
    ...overrides,
  };
}

/** The smallest thing that can stand in for a backend's `getTemplate`. */
export class DictStore {
  readonly templates = new Map<string, ManagedTemplate>();

  /** Every (key, version) asked for, so a test can assert what was read and what was not. */
  readonly reads: { key: string; version: number | null }[] = [];

  constructor(...templates: ManagedTemplate[]) {
    for (const template of templates) {
      this.add(template);
    }
  }

  add(template: ManagedTemplate): ManagedTemplate {
    this.templates.set(`${template.key}@${template.version}`, template);
    return template;
  }

  getTemplate = async (key: string, version: number | null = null): Promise<ManagedTemplate> => {
    this.reads.push({ key, version });
    const matches = [...this.templates.values()]
      .filter((template) => template.key === key)
      .filter((template) => version === null || template.version === version);
    if (matches.length === 0) {
      throw new ManagedTemplateNotFoundError(key);
    }
    return matches.reduce((latest, template) =>
      template.version > latest.version ? template : latest,
    );
  };
}
