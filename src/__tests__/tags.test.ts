import { describe, expect, it } from 'vitest';

import { MAX_SLUG_LENGTH, nextAvailableSlug, normalizeTagText, slugifyTag } from '../tags.js';

describe('normalizeTagText', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(normalizeTagText('  Black   Friday \n')).toBe('Black Friday');
  });

  it('leaves casing alone', () => {
    expect(normalizeTagText('Black Friday')).toBe('Black Friday');
  });

  it('empties out text that is only whitespace', () => {
    expect(normalizeTagText('   ')).toBe('');
  });
});

describe('slugifyTag', () => {
  it('lowercases and joins words with a dash', () => {
    expect(slugifyTag('Black Friday')).toBe('black-friday');
  });

  it('folds accents away, so an accented tag and its plain spelling are one tag', () => {
    expect(slugifyTag('Promoção')).toBe('promocao');
    expect(slugifyTag('Promocao')).toBe('promocao');
  });

  it('collapses runs of punctuation into a single dash', () => {
    expect(slugifyTag('a -- b__c')).toBe('a-b-c');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugifyTag('  --hello--  ')).toBe('hello');
  });

  it('returns an empty slug for text with nothing sluggable', () => {
    expect(slugifyTag('!!!')).toBe('');
    expect(slugifyTag('   ')).toBe('');
  });

  it('keeps non-Latin text rather than losing the tag to transliteration', () => {
    expect(slugifyTag('日本語')).toBe('日本語');
    expect(slugifyTag('Привет мир')).toBe('привет-мир');
  });

  it('caps the slug at the documented length', () => {
    expect(slugifyTag('a'.repeat(500))).toHaveLength(MAX_SLUG_LENGTH);
  });
});

describe('nextAvailableSlug', () => {
  it('hands the base back when nothing has taken it', async () => {
    expect(await nextAvailableSlug('welcome', () => false)).toBe('welcome');
  });

  it('appends -2 for the first collision', async () => {
    const taken = new Set(['welcome']);
    expect(await nextAvailableSlug('welcome', (slug) => taken.has(slug))).toBe('welcome-2');
  });

  it('keeps counting past a taken suffix', async () => {
    const taken = new Set(['welcome', 'welcome-2', 'welcome-3']);
    expect(await nextAvailableSlug('welcome', (slug) => taken.has(slug))).toBe('welcome-4');
  });

  it('truncates the base so a suffixed slug still fits the limit', async () => {
    const base = 'a'.repeat(MAX_SLUG_LENGTH);
    const taken = new Set([base]);

    const slug = await nextAvailableSlug(base, (candidate) => taken.has(candidate));

    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith('-2')).toBe(true);
  });

  it('accepts an asynchronous lookup, which is what a real store needs', async () => {
    const taken = new Set(['welcome']);
    expect(await nextAvailableSlug('welcome', async (slug) => taken.has(slug))).toBe('welcome-2');
  });
});
