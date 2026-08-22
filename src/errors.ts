/**
 * Every failure this package reports, as a class a caller can branch on.
 *
 * `instanceof` works across the whole hierarchy because each constructor restores the prototype
 * chain — TypeScript compiled to an ES5-era target breaks it otherwise, and this package is
 * consumed by applications that pick their own target.
 */

export class ManagedTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when a template is not found in the backend. */
export class ManagedTemplateNotFoundError extends ManagedTemplateError {}

/** Raised when a filter is malformed or names a field the vocabulary does not have. */
export class ManagedTemplateInvalidFilterError extends ManagedTemplateError {}

/**
 * Raised when a listing asks for an order the configured backend cannot apply.
 *
 * This throws rather than quietly dropping the order, which is the difference between ordering
 * and filtering: a dropped filter returns more rows than asked for, which a caller can see, while
 * a dropped order returns the same rows in an arbitrary sequence that looks sorted. Read
 * `getBackendSupportedFilterCapabilities()` and offer only the fields it reports.
 */
export class ManagedTemplateUnsupportedOrderingError extends ManagedTemplateError {}

/** Raised when a status change is attributed to a user the backend cannot resolve. */
export class ManagedTemplateChangeUserNotFoundError extends ManagedTemplateError {}

/** Raised when a status change is not allowed from the version's current status. */
export class ManagedTemplateStatusTransitionError extends ManagedTemplateError {}

/** Raised when a tag is not found in the backend. */
export class ManagedTemplateTagNotFoundError extends ManagedTemplateError {}

/** Raised when creating a tag whose text already slugs onto an existing tag. */
export class ManagedTemplateTagAlreadyExistsError extends ManagedTemplateError {}

/** Raised when a tag's text is empty or has nothing that can be slugified. */
export class ManagedTemplateInvalidTagError extends ManagedTemplateError {}

/**
 * Base class for every failure of {@link TemplateComposer}.
 *
 * Composition runs before the template engine does, so nothing here can be caught (or reported)
 * by the engine downstream. Catch this to treat "the template could not be assembled" as one
 * condition, or a subclass to tell a typo apart from a missing base.
 */
export class ManagedTemplateCompositionError extends ManagedTemplateError {}

/** Raised when a `managed_*` composition tag is malformed, unknown or unbalanced. */
export class ManagedTemplateCompositionSyntaxError extends ManagedTemplateCompositionError {}

/**
 * Raised when a template extends or includes a template that does not exist.
 *
 * The Python sibling makes this a `ManagedTemplateNotFoundError` as well, so code already
 * handling a missing template keeps working. TypeScript has no multiple inheritance, so the
 * relationship is carried by {@link isNotFoundError} instead — check with that rather than with
 * a bare `instanceof ManagedTemplateNotFoundError`, and test for
 * `ManagedTemplateCompositionError` *before* "not found" wherever the distinction matters: a
 * base that does not exist is a broken composition of a template that does.
 */
export class ManagedTemplateCompositionReferenceError extends ManagedTemplateCompositionError {}

/** Raised when a chain of extends/include references comes back to where it started. */
export class ManagedTemplateCompositionCycleError extends ManagedTemplateCompositionError {}

/** Raised when a chain of references runs deeper than the composer's `maxDepth`. */
export class ManagedTemplateCompositionDepthError extends ManagedTemplateCompositionError {}

/**
 * Whether an error means "the thing you asked for is not in the store".
 *
 * True for {@link ManagedTemplateNotFoundError} and for
 * {@link ManagedTemplateCompositionReferenceError}, which is a missing template reached through
 * a template that exists.
 */
export function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof ManagedTemplateNotFoundError ||
    error instanceof ManagedTemplateCompositionReferenceError
  );
}
