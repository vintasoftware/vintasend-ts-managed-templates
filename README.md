# vintasend-managed-templates

Database-backed notification templates for
[VintaSend](https://github.com/vintasoftware/vintasend-ts): versioning, a
draft/active/inactive/archived lifecycle with an audit trail, tags, composition and filtering — all
on top of a storage seam you (or a ready-made package) implement.

A regular VintaSend template renderer reads templates from wherever its engine looks, which is
usually files on disk. That means every copy change is a deploy. This package moves the templates
into a data store so someone who is not a developer can edit them, keeps every edit as a new
version, and lets you publish a version deliberately instead of the moment it is saved.

It is storage-agnostic on its own — it defines the interface, not the database. Pair it with a
manager backend such as
[vintasend-medplum-template-manager](https://github.com/vintasoftware/vintasend-medplum-template-manager/),
or implement `BaseTemplateManagerBackend` yourself.

This is the TypeScript sibling of
[vintasend-managed-templates](https://github.com/vintasoftware/vintasend-managed-templates) for
Python. The two agree on the tag language, the slug rules, the lifecycle and the filter vocabulary,
so a store written by one is readable by the other.

## Install

```bash
npm install vintasend-managed-templates
```

Node 20+. The only dependency is `vintasend` itself.

## The pieces

| Piece | What it is |
|---|---|
| `BaseTemplateManagerBackend` | The storage seam. Template CRUD, versions, status history, tags, filtering and pagination. |
| `ManagedTemplateService` | The API you call. Wraps a backend and a renderer with version resolution, status-transition rules, filter validation and tag normalization. |
| `ManagedTemplateEmailRenderer` / `ManagedTemplateTextRenderer` | A VintaSend template renderer that wraps *another* renderer and feeds it a stored template instead of a template path. |
| `TemplateComposer` | Resolves template inheritance and inclusion against the store, before the engine runs. |
| `slugifyTag` / `nextAvailableSlug` | The shared slug rules, so every backend derives the same slug from the same text. |
| `InMemoryTemplateManagerBackend` | A complete backend that keeps everything in memory — for tests, and as the executable statement of what the seam means. |

Everything is asynchronous, unlike the Python sibling: a TypeScript store is a network call more
often than not.

## Quick start

```ts
import {
  InMemoryTemplateManagerBackend,
  ManagedTemplateEmailRenderer,
  ManagedTemplateService,
} from 'vintasend-managed-templates';

const managerBackend = new InMemoryTemplateManagerBackend(); // any BaseTemplateManagerBackend
const renderer = new ManagedTemplateEmailRenderer<Config>(
  managerBackend,
  innerRenderer, // any VintaSend email renderer
);
const service = new ManagedTemplateService<Config>(managerBackend, renderer);

await service.createTemplate({
  key: 'welcome', // what notifications reference
  name: 'Welcome email',
  description: 'Sent right after signup',
  templateManagedBackend: 'medplum', // which manager backend stores it
  bodyTemplate: '<p>Hi #{name}, welcome!</p>',
  subjectTemplate: 'Welcome aboard',
  preheaderTemplate: null,
  tenant: null,
  tags: ['onboarding', 'Black Friday'],
});

await service.activate('welcome', null, 'hugo@example.com');
```

To send through it, hand the wrapping renderer to your adapter and set the notification's
`bodyTemplate` to the template **key** instead of a path:

```ts
const notificationService = new VintaSendFactory<Config>().create(
  [new MyEmailAdapterFactory().create(renderer, false, adapterConfig)],
  notificationBackend,
);

await notificationService.createNotification({
  userId: user.id,
  notificationType: 'EMAIL',
  title: 'Welcome',
  bodyTemplate: 'welcome', // a managed template key, not a file path
  contextName: 'welcomeContext',
  contextParameters: { userId: user.id },
  sendAfter: null,
  subjectTemplate: null,
  extraParams: null,
});
```

Nothing else about creating or sending notifications changes.

### What the inner renderer has to do

`ManagedTemplateRenderer` looks the template up, builds the content out of the stored strings, and
calls the inner renderer's `renderFromTemplateContent`. So the inner renderer receives **template
source in the `body` field**, where a file-based renderer would expect a name a loader resolves.

Every renderer in the VintaSend ecosystem implements `renderFromTemplateContent` — it is the seam
VintaSend already uses to render content it holds rather than loads — so `vintasend-pug`,
`vintasend-react-email` and the rest work unchanged. A renderer of your own only needs to compile
the string it is handed rather than open a file.

The email content is VintaSend's `EmailTemplateContent` plus one field:

```ts
type ManagedEmailTemplateContent = {
  subject: string | null;
  body: string;
  preheader: string | null; // added, so a renderer that knows about preheaders can use it
};
```

A renderer that does not know about preheaders ignores the extra field, which is why it is added
rather than replacing the shape.

## Composition: bases, blocks and includes

A file-based renderer gets composition for free. Pug's `extends` and Nunjucks' `include` hand a
*name* to a loader, and a loader reads files — so the header, the footer and the wrapper every
email shares live in one file that every other file points at.

Managed templates are not files. They reach the engine as source, so a loader has nothing to
resolve and those tags have nothing to load. Without composition the shared chrome would have to be
pasted into every row in the store, and changing the footer would mean editing all of them.

This package resolves its own set of tags **before** the engine sees anything. What the engine
receives is one flat string with no `managed_*` tag left in it; its own syntax is untouched.

```ts
await service.createTemplate({
  key: 'base-email',
  name: 'Base email',
  description: 'The wrapper every email uses',
  templateManagedBackend: 'medplum',
  bodyTemplate: [
    '<html>',
    '  <body>',
    '    {% managed_block header %}<h1>Acme</h1>{% managed_endblock %}',
    '    {% managed_children %}',
    '    {% managed_include "footer" %}',
    '  </body>',
    '</html>',
  ].join('\n'),
  subjectTemplate: '[Acme] {% managed_children %}',
  preheaderTemplate: null,
  tenant: null,
});

await service.createTemplate({
  key: 'welcome',
  name: 'Welcome email',
  description: 'Sent right after signup',
  templateManagedBackend: 'medplum',
  bodyTemplate: [
    '{% managed_extends "base-email" %}',
    '{% managed_block header %}<h1>Welcome!</h1>{% managed_endblock %}',
    '<p>Hi #{name}, welcome aboard.</p>',
  ].join('\n'),
  subjectTemplate: '{% managed_extends "base-email" %}Welcome aboard',
  preheaderTemplate: null,
  tenant: null,
});
```

`welcome` now renders inside the base, with its own header and the shared footer, and its subject
comes out as `[Acme] Welcome aboard`. `#{name}` is never looked at — the context is the engine's
business.

### The tags

| Tag | What it does |
|---|---|
| `{% managed_extends "key" %}` | This template is a child of `key`. At most one per template, never inside a block. Pin the parent with `version=2`. |
| `{% managed_children %}` | In a base: where the child's content goes. Rendered with no child, the hole is simply empty. |
| `{% managed_block name %}…{% managed_endblock %}` | A named region a child may replace. Unreplaced, it renders what it was declared with. Blocks may nest. |
| `{% managed_super %}` | Inside a child's block: the content it is overriding. Chains through as many levels of inheritance as there are. |
| `{% managed_include "key" %}` | Splice another template in here. It is composed in full first, so an include may itself extend and include. Pins the same way: `version=7`. |

Everything a child writes **outside** a block is its children content, and it lands in the base's
`{% managed_children %}`. So a child can both fill the hole and override named regions.

The `managed_` prefix is reserved: an unknown `{% managed_something %}` is an error rather than
text passed through, so a typo surfaces at edit time instead of shipping. Change the prefix by
handing the renderer or the service its own composer:

```ts
import { TemplateComposer } from 'vintasend-managed-templates';

const composer = TemplateComposer.fromBackend(managerBackend, { tagPrefix: 'tpl_' });
const renderer = new ManagedTemplateEmailRenderer<Config>(managerBackend, innerRenderer, {
  composer,
});
```

### One field at a time

A template carries three sources — body, subject and preheader — and each composes against the
**same field** of the template it references. A child's body extends the base's body; its subject
extends the base's subject. So a base can define a subject prefix and a body wrapper at once, and
neither leaks into the other. A field the base leaves empty composes to nothing rather than to an
error.

### Whitespace

A structural tag (`extends`, `block`, `endblock`) alone on its line is taken out *with* the line,
so a layout written across several lines does not compose into one padded with blank ones. The
placeholder tags (`children`, `include`, `super`) are never line-trimmed: what replaces them lands
exactly where the tag stood, indentation and all.

### Abstract templates

A template is *abstract* when it declares a `{% managed_children %}` hole, or declares blocks
without extending anything — a layout meant to be built on rather than sent. That is a fact about
the source, so it follows the template as it is edited.

**The check** recomputes from the source every time, which makes it the authority:

```ts
service.isAbstract(base); // true
service.isAbstract(welcome); // false
```

**The flag** is that same answer, denormalized onto the template so it can be queried:

```ts
base.isAbstract; // true — stored, not recomputed
await service.getFilteredTemplates({ isAbstract: false }); // every sendable template
```

Filtering is the reason the flag exists. Without it, a picker that has to leave the bases out would
read and parse every row in the store to draw one page. Nobody writes the flag — there is no field
for it on either write input — because a stored copy that disagreed with the source would be a lie
a filter goes on repeating. It is a **backend's job to derive it on every write** with
`isAbstract()`; see [Implementing a manager backend](#implementing-a-manager-backend).

Composing an abstract template directly is allowed and gives you the layout with an empty hole.
Neither the check nor the flag refuses anything — keeping bases out of a picker is the host's call.

### Versions

A reference with no version resolves the same way any other read does: to whatever version that key
currently is. Pin it when a template must keep composing against an exact parent.

```
{% managed_extends "base-email" version=2 %}
{% managed_include "footer" version=7 %}
```

Nothing inside the quoted key is interpreted, so a key is only ever a key.

### Checking a template before it ships

Composition failures are this package's, not the engine's, so nothing downstream can report them.
Catch them where someone can still fix them:

```ts
await service.validateComposition(template); // throws exactly what rendering would have
await service.getComposedTemplate('welcome'); // what the engine will actually receive
service.getTemplateReferences(template); // the bases and fragments it names, unresolved
```

| Error | Thrown when |
|---|---|
| `ManagedTemplateCompositionSyntaxError` | A tag is malformed, unknown, or unbalanced |
| `ManagedTemplateCompositionReferenceError` | A base or fragment does not exist |
| `ManagedTemplateCompositionCycleError` | The references loop |
| `ManagedTemplateCompositionDepthError` | The chain runs past the composer's `maxDepth` (25 by default) |

All four extend `ManagedTemplateCompositionError`. A missing *reference* is also a missing
*template*: Python expresses that with multiple inheritance, which TypeScript has no equivalent
for, so use `isNotFoundError(error)` when you want to treat the two as one condition — and test for
`ManagedTemplateCompositionError` **first** where the distinction matters, since a base that does
not exist is a broken composition of a template that does.

### Turning it off

Composition is on by default. A store that predates it and holds `managed_`-prefixed text meant to
reach the engine verbatim can opt out:

```ts
new ManagedTemplateEmailRenderer(managerBackend, innerRenderer, { composeTemplates: false });
new ManagedTemplateService(managerBackend, renderer, { composeTemplates: false });
```

Reads are never composed either way: `getTemplate` hands back exactly what is stored, which is what
an editing UI needs. `getComposedTemplate` is the explicit way to ask for the assembled form.

## Templates and versions

Templates are **versioned, never edited in place**. `updateTemplate` copies the latest version
forward, applies the fields the input sets, and returns the new version — so a published version's
body can never change under a notification that already referenced it. The copy starts in `draft`
whatever its predecessor was in.

```ts
await service.updateTemplate('welcome', {
  bodyTemplate: '<p>Hi #{name}, welcome aboard!</p>',
  // every other field is carried forward from the latest version
  // tags: undefined carries them forward; [] clears them
});

await service.getTemplate('welcome'); // latest version
await service.getTemplate('welcome', 1); // a specific one
await service.getTemplateVersions('welcome'); // every version, newest first
```

An absent `version` means "the latest version of this key" everywhere in the service — reads,
status changes, tagging, and rendering — so callers only deal with version numbers when they
actually want a specific one.

### Version-pinned rendering

`renderManaged` reports which version rendered, which is the only way to find out afterwards what
an unpinned notification went out with:

```ts
const { version, rendered } = await renderer.renderManaged(notification, context);
```

Which version renders is decided in this order: an explicit `version` argument, then the
notification's own `requestedTemplateVersion`, then whatever the backend considers current.

`requestedTemplateVersion` is a first-class VintaSend field: pass it to `createNotification`, or
let the service resolve it for you with `pinTemplateVersions`. This package is what makes it mean
anything — `getLatestTemplateVersion` is how the service resolves "whatever is current right now",
and it is overridden here to read the store.

`render` also stamps the version it used onto the payload it returns, as `templateVersion`. An
adapter returns that payload from `send()`, and the service records it on the notification as
`usedTemplateVersion` — which on an unpinned notification is the only record of which version went
out. See
[Template Version Pinning](https://github.com/vintasoftware/vintasend-ts#template-version-pinning).

## Statuses

A version moves through `draft → active → inactive → archived`, and every move is written to the
backend's audit trail:

```ts
await service.activate('welcome', null, 'hugo@example.com');
await service.deactivate('welcome');
await service.archive('welcome', 1);
await service.getStatusHistory('welcome'); // newest change first
service.canTransitionTo(template, 'active');
service.allowedTransitionsFor(template); // what a UI should offer
```

The default transition table:

| From | May move to |
|---|---|
| `draft` | `active`, `archived` |
| `active` | `inactive`, `archived` |
| `inactive` | `active`, `archived` |
| `archived` | — terminal |

Anything else throws `ManagedTemplateStatusTransitionError`. Setting a version to the status it
already holds is a no-op: no history entry, no error. Pass your own `allowedStatusTransitions` for
a different lifecycle, or `validateStatusTransitions: false` to leave the ordering entirely to your
application.

Two things the service deliberately does *not* decide for you:

* **A key may have several `active` versions at once.** Activating one does not deactivate the
  others; choosing which active version wins at render time is the host's call.
* **`changedBy` is passed through untouched, `null` included.** Attribution is never required.

## Tags

Tags are many-to-many with template *versions* and are identified by a slug derived from the text
someone typed. Slugging lives in `tags.ts` rather than in a backend, so every store agrees on what
`Promoção` slugs to — and agrees with the Python package. Every call that takes a slug also accepts
the original text.

```ts
await service.addTemplateTags('welcome', ['Black Friday']); // creates the tag if it is new
await service.removeTemplateTags('welcome', ['black-friday']);
await service.setTemplateTags('welcome', ['onboarding']); // replaces; [] clears
await service.getTemplatesByTags(['onboarding', 'email'], false); // any of them
await service.getActiveTags(); // what a tag picker should show
```

Retagging **edits the version in place** instead of creating one. Tags are how a template is found,
not part of what it renders, so relabelling for findability does not spawn a version and drop it
back to `draft`.

Archiving a tag (`archiveTag` / `restoreTag`) takes it out of the pickers but keeps every link:
filtering by an archived tag still returns the templates carrying it. `deleteTag` is the
irreversible one — it removes the label from the templates too.

Text with nothing sluggable in it (`'  '`, `'!!!'`) throws `ManagedTemplateInvalidTagError` at the
call site, rather than becoming a tag no filter can ever name.

## Filtering and pagination

Filters are plain objects spelled exactly the way `vintasend` spells its notification filters, and
compose with `and` / `or` / `not`:

```ts
await service.getFilteredTemplates({
  and: [
    { status: { lookup: 'in', value: ['active'] } },
    { name: { lookup: 'includes', value: 'welcome', caseSensitive: false } },
    { includesAnyOfTags: ['onboarding', 'transactional'] },
    { createdAtRange: { from: new Date('2026-01-01') } },
  ],
});

await service.getPaginatedFilteredTemplates(filters, 1, 20); // page is 1-indexed
```

Fields: `name`, `description`, `key`, `version`, `templateManagedBackend`, `status`,
`createdAtRange`, `updatedAtRange`, `includesAllTags`, `includesAnyOfTags`, `isAbstract`,
`mostRecentActiveVersion`. String lookups are `exact` / `startsWith` / `endsWith` / `includes`;
numeric ones are `gt` / `gte` / `lt` / `lte`.

A filter is checked for shape and field names before it reaches the backend, so a typo throws
`ManagedTemplateInvalidFilterError` at the call site instead of silently matching nothing deep
inside a backend's query translation.

### One row per key: `mostRecentActiveVersion`

The store holds a row per *version*, so an unfiltered read shows a template once for every version
it has ever had. `mostRecentActiveVersion` collapses that to one row per key — the highest-numbered
`active` or `draft` version, which is what is live plus the draft on its way to replacing it. A key
whose versions are all `inactive` or `archived` has no current version and drops out.

```ts
await service.getAllTemplates(); // one row per key — the current version
await service.getAllTemplates(true); // every version of every key
await service.getPaginatedTemplates(1, 20); // same default
await service.getFilteredTemplates({ mostRecentActiveVersion: true }); // the filter itself
```

**The two listing methods apply it by default**; pass `true` for the raw read.
`getFilteredTemplates` and `getPaginatedFilteredTemplates` do *not* add it — a filter means what it
says — so name the field yourself when a filtered listing should be one row per key.

### Capabilities

A backend declares only what it *cannot* do, and its report is merged over the library default:

```ts
service.getBackendSupportedFilterCapabilities();
// { 'logical.or': false, 'stringLookups.includes': false, 'orderBy.name': false, ... }
```

Read it to drop a filter a backend cannot honour rather than sending one it will ignore or throw
on.

Most keys default to `true`, so a filter field added in a later release does not force every
backend to re-declare support for it. **New vocabulary is the exception and defaults to `false`** —
otherwise every backend that shipped before the field existed would claim a filter it silently
ignores. Every `orderBy.*` key is in that category today.

### Ordering

`getPaginatedTemplates` and `getPaginatedFilteredTemplates` take an optional `orderBy`:

```ts
await service.getPaginatedTemplates(1, 20, false, { field: 'updatedAt', direction: 'desc' });
```

Orderable fields are `key`, `name`, `version`, `status`, `createdAt` and `updatedAt` — each a
scalar the backend already stores per row, so a store can answer it from an index. Tags are absent
because a many-to-many has no single value to compare, and `mostRecentActiveVersion` because it is
a filter, not a field.

**An order the backend cannot apply is refused, not dropped.** This is the one place the library
does not follow the "drop what the backend cannot do" rule, and the asymmetry is deliberate:

| | Unsupported filter | Unsupported order |
|---|---|---|
| If ignored | more rows come back than asked for | the same rows come back in an arbitrary sequence |
| Can the caller tell? | yes — the rows are visibly wrong | no |

So `ManagedTemplateService` throws `ManagedTemplateUnsupportedOrderingError`, naming the capability
key. Ask first and offer only what the backend reports:

```ts
service.getSupportedOrderByFields(); // ['createdAt', 'updatedAt']
```

The order has to reach the store. Sorting a page after it has been chosen orders rows *within* the
page while the rows selected *for* it came back in the backend's own order — correct-looking on
page 1 and wrong on every page after it. A backend that holds the whole result set anyway can sort
with `sortTemplates` from this package, which gives a **total, stable** order: every field breaks
ties on `(key, version)`, and neither the tiebreak nor the placement of absent values flips with
the direction, so a page boundary cannot move between two requests and drop or repeat a row.

## Implementing a manager backend

Implement `BaseTemplateManagerBackend`. `InMemoryTemplateManagerBackend` is a complete
implementation to read against, and the seam's own test suite
(`src/__tests__/in-memory-backend.test.ts`) doubles as a conformance checklist.

The three rules that are easy to miss:

1. **Derive `isAbstract` on every write** that touches a source field, with `isAbstract()` from
   this package, and store the answer. A source whose composition tags are malformed has no answer:
   store `false` rather than letting the syntax error out of the write.
2. **`updateTemplate` inserts, never updates.** Copy the latest version forward, bump the version,
   start the copy in `draft`, and leave the version it was copied from untouched.
3. **`mostRecentActiveVersion` is answered against the key, not the row.** "This row is `active` or
   `draft`, and no `active`-or-`draft` row of the same key is numbered higher."

Slug every tag with `slugifyTag` and keep slugs unique with `nextAvailableSlug`, so your store and
every other one derive the same identity from the same text.

## Development

```bash
npm install
npm test
npm run typecheck
npm run lint
```

## License

MIT
