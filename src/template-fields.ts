/**
 * How a blank template field is read, on every write and in every backend.
 *
 * A subject or preheader that is empty or whitespace-only means "no value", not "a value that is
 * blank": FHIR cannot store such a string, and a blank subject is no more useful in any other
 * store. Normalizing in one place keeps every backend in agreement.
 */

/** True for `''` and whitespace-only strings. `null` and `undefined` are not blank, they are absent. */
export function isBlank(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() === '';
}

/** A blank string becomes `null` ("no value"); anything else is returned as it was. */
export function blankToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null || isBlank(value)) {
    return null;
  }
  return value;
}

/**
 * The value of an optional template field on a new version.
 *
 * - `null` / `undefined`: carry the latest version's value forward.
 * - blank (`''` or whitespace-only): clear the field.
 * - anything else: replace it.
 */
export function resolveUpdatedField(
  incoming: string | null | undefined,
  previous: string | null,
): string | null {
  if (incoming === undefined || incoming === null) {
    return previous;
  }
  return blankToNull(incoming);
}
