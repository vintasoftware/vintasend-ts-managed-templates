import { describe, expect, it } from 'vitest';

import { matchesTemplateFilter } from '../filter-evaluation.js';
import { makeTemplate } from './helpers.js';

const template = makeTemplate('welcome', 'body', { name: 'Welcome email' });

describe('matchesTemplateFilter', () => {
  it('evaluates a filter with no store behind it', () => {
    expect(
      matchesTemplateFilter(template, {
        name: { lookup: 'includes', value: 'WELCOME', caseSensitive: false },
      }),
    ).toBe(true);
  });

  it('supports the lookups a query language may not, which is why it exists', () => {
    expect(matchesTemplateFilter(template, { key: { lookup: 'endsWith', value: 'come' } })).toBe(
      true,
    );
  });

  it('refuses to guess at mostRecentActiveVersion without the key other versions', () => {
    expect(() => matchesTemplateFilter(template, { mostRecentActiveVersion: true })).toThrow(
      /versionsOfKey/,
    );
  });

  it('answers mostRecentActiveVersion when the key versions are available', () => {
    const newer = makeTemplate('welcome', 'body', { version: 2 });

    expect(
      matchesTemplateFilter(
        template,
        { mostRecentActiveVersion: true },
        {
          versionsOfKey: () => [template, newer],
        },
      ),
    ).toBe(false);
    expect(
      matchesTemplateFilter(
        newer,
        { mostRecentActiveVersion: true },
        {
          versionsOfKey: () => [template, newer],
        },
      ),
    ).toBe(true);
  });
});
