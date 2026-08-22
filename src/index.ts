// The storage seam
export type { BaseTemplateManagerBackend } from './base-template-manager-backend.js';
export type {
  TemplateComposerOptions,
  TemplateReference,
  TemplateResolver,
} from './composition.js';
// Composition
export {
  DEFAULT_MAX_DEPTH,
  DEFAULT_TAG_PREFIX,
  isAbstract,
  TemplateComposer,
} from './composition.js';
export type {
  ManagedTemplateStatus,
  ManagedTemplateTagStatus,
  TemplateField,
} from './constants.js';
// Constants
export {
  MANAGED_TEMPLATE_STATUSES,
  MANAGED_TEMPLATE_TAG_STATUSES,
  MOST_RECENT_ACTIVE_VERSION_STATUSES,
  TEMPLATE_FIELDS,
} from './constants.js';
// Errors
export {
  isNotFoundError,
  ManagedTemplateChangeUserNotFoundError,
  ManagedTemplateCompositionCycleError,
  ManagedTemplateCompositionDepthError,
  ManagedTemplateCompositionError,
  ManagedTemplateCompositionReferenceError,
  ManagedTemplateCompositionSyntaxError,
  ManagedTemplateError,
  ManagedTemplateInvalidFilterError,
  ManagedTemplateInvalidTagError,
  ManagedTemplateNotFoundError,
  ManagedTemplateStatusTransitionError,
  ManagedTemplateTagAlreadyExistsError,
  ManagedTemplateTagNotFoundError,
  ManagedTemplateUnsupportedOrderingError,
} from './errors.js';
export type { FilterEvaluationContext } from './filter-evaluation.js';
// Filter evaluation, for a backend that has to finish a filter its query language cannot express
export {
  isMostRecentActiveVersion,
  matchesDateRange,
  matchesInteger,
  matchesStatus,
  matchesString,
  matchesTemplateFilter,
  normalizeSlugs,
  paginate,
  sortTemplates,
} from './filter-evaluation.js';
export type {
  DateRange,
  IntegerFieldFilter,
  ManagedTemplateFilter,
  ManagedTemplateFilterCapabilities,
  ManagedTemplateFilterFields,
  ManagedTemplateOrderBy,
  ManagedTemplateOrderByField,
  ManagedTemplateOrderDirection,
  ManagedTemplateStatusFilter,
  NumericFilterLookup,
  StringFieldFilter,
  StringFilterLookup,
  TagsFieldFilter,
} from './filters.js';
// Filters and capabilities
export {
  DEFAULT_TEMPLATE_BACKEND_FILTER_CAPABILITIES,
  FLAG_FILTER_FIELDS,
  isDateRange,
  isEmptyFilter,
  isFieldFilter,
  isNumericFilterLookup,
  isStatusExactLookup,
  isStatusInLookup,
  isStringFilterLookup,
  isTagsFilter,
  KNOWN_FILTER_FIELDS,
  MANAGED_TEMPLATE_ORDER_BY_FIELDS,
  orderByCapabilityKey,
  pruneUnsupportedFilters,
  supportsCapability,
  TAG_FILTER_FIELDS,
} from './filters.js';
export type { InMemoryTemplateManagerBackendOptions } from './in-memory-template-manager-backend.js';
// A backend to develop and test against
export { InMemoryTemplateManagerBackend } from './in-memory-template-manager-backend.js';
export type {
  ManagedEmailTemplateContent,
  ManagedTemplateRendererOptions,
  ManagedTemplateRenderResult,
  TextTemplate,
  TextTemplateContent,
  VersionPinnedNotification,
} from './managed-template-renderer.js';
// Renderers
export {
  ManagedTemplateEmailRenderer,
  ManagedTemplateRenderer,
  ManagedTemplateTextRenderer,
  requestedTemplateVersion,
} from './managed-template-renderer.js';
export type { ManagedTemplateServiceOptions } from './managed-template-service.js';
// The service
export { DEFAULT_STATUS_TRANSITIONS, ManagedTemplateService } from './managed-template-service.js';
// Tag slugging
export { MAX_SLUG_LENGTH, nextAvailableSlug, normalizeTagText, slugifyTag } from './tags.js';
// Dataclasses
export type {
  ManagedTemplate,
  ManagedTemplateCreateInput,
  ManagedTemplateId,
  ManagedTemplateStatusHistory,
  ManagedTemplateTag,
  ManagedTemplateUpdateInput,
} from './types.js';
