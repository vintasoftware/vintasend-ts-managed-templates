/**
 * Turning free text into a tag slug, and keeping that slug unique.
 *
 * Tags are typed by humans ("Black Friday", "black friday ", "Black-Friday") and searched by
 * machines, so every tag carries a normalized `slug` alongside the text it was written as. The
 * slug is the identity: it is what a filter matches on, what a URL carries, and what a store
 * enforces uniqueness over.
 *
 * Slugging lives here rather than in a backend so every implementation of the storage seam
 * produces the same slug for the same text — and so the TypeScript and Python packages agree,
 * which matters the moment two services read the same store.
 *
 * The rules, in order:
 *
 * 1. Unicode-normalize (NFKD) and drop everything outside ASCII, so `Promoção` and `Promocao`
 *    are the same tag.
 * 2. Lowercase, then replace every run of non-alphanumeric characters with a single `-`.
 * 3. Trim leading and trailing `-`.
 *
 * Text that is entirely non-Latin (`日本語`) folds to nothing under step 1, so it falls back to a
 * Unicode-preserving pass that keeps alphanumeric characters as they are. Losing a whole tag to
 * transliteration would be worse than a slug that is not URL-clean.
 */

/**
 * Longest slug this module will produce. Chosen to fit the 255-char columns backends use for
 * it, leaving room for the `-2` / `-3` suffix uniqueness may need to append.
 */
export const MAX_SLUG_LENGTH = 240;

const NON_ALPHANUMERIC = /[^a-z0-9]+/g;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const DASH_RUN = /-+/g;
const ASCII_CEILING = 0x80;

function trimDashes(value: string): string {
  return value.replace(/^-+/, '').replace(/-+$/, '');
}

/**
 * Drop everything outside ASCII, the way Python's `str.encode('ascii', 'ignore')` does.
 *
 * Dropping rather than substituting is what makes step 1 work: after NFKD, `ç` is `c` plus a
 * combining cedilla, and the cedilla has to *vanish* for `Promoção` to slug as `promocao`.
 * Turning it into a separator instead would give `promoc-ao`, a different tag.
 */
function asciiOnly(value: string): string {
  let result = '';
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) < ASCII_CEILING) {
      result += character;
    }
  }
  return result;
}

/**
 * Collapse a tag's whitespace and trim it, leaving the caller's casing intact.
 *
 * The text is what a UI displays, so this is deliberately gentle — it fixes the artifacts of
 * typing (a trailing space, a double space) and nothing else. {@link slugifyTag} handles the rest.
 */
export function normalizeTagText(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Normalize free text into a tag slug. Returns `''` for text with nothing sluggable.
 *
 * An empty result is returned rather than thrown on so callers can decide what it means: the
 * service rejects it, while a filter treats it as a tag that matches nothing.
 */
export function slugifyTag(text: string): string {
  const folded = asciiOnly(text.normalize('NFKD'));
  let slug = trimDashes(folded.toLowerCase().replace(NON_ALPHANUMERIC, '-'));

  if (!slug) {
    slug = slugifyUnicode(text);
  }

  return trimDashes(slug.slice(0, MAX_SLUG_LENGTH));
}

/**
 * Slug for text ASCII folding empties out — `日本語`, `Привет` and the like.
 *
 * Alphanumeric characters survive as they are; everything else becomes a separator. Not
 * URL-clean without percent-encoding, but a tag that exists beats a tag that vanished.
 */
function slugifyUnicode(text: string): string {
  const characters = Array.from(text.toLowerCase(), (character) =>
    ALPHANUMERIC.test(character) ? character : '-',
  );
  return trimDashes(characters.join('').replace(DASH_RUN, '-'));
}

/**
 * Return `slug`, or the first `slug-N` that `isTaken` says is free.
 *
 * Backends call this while holding whatever lock they use for tag writes: `isTaken` is a read,
 * so two concurrent creates can both be told the same slug is free. The unique constraint on
 * the store is what actually decides, and this only keeps the common case from hitting it.
 *
 * @param slug an already-slugified base.
 * @param isTaken resolves to true when a tag with that slug already exists.
 */
export async function nextAvailableSlug(
  slug: string,
  isTaken: (candidate: string) => boolean | Promise<boolean>,
): Promise<string> {
  if (!(await isTaken(slug))) {
    return slug;
  }

  // Truncate the base first so appending the suffix cannot push the result over the limit.
  for (let suffixIndex = 2; ; suffixIndex += 1) {
    const suffix = `-${suffixIndex}`;
    const base = trimDashes(slug.slice(0, MAX_SLUG_LENGTH - suffix.length));
    const candidate = `${base}${suffix}`;
    if (!(await isTaken(candidate))) {
      return candidate;
    }
  }
}
