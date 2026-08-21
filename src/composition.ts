/**
 * Inheritance and inclusion for managed templates, resolved before the engine runs.
 *
 * A file-based renderer gets composition for free. Pug's `extends` and Nunjucks' `include` hand
 * a *name* to a loader, and a loader reads files, so the header, the footer and the wrapper
 * every email shares live in one file that every other file points at.
 *
 * Managed templates are not files. They reach the engine as source, pulled out of a store and
 * handed to `renderFromTemplateContent` as a string, so a loader has nothing to resolve and
 * those tags have nothing to load. Without this module the shared chrome would have to be
 * pasted into every template in the store, and changing the footer would mean editing every row
 * that has one.
 *
 * This module puts composition back where the store can serve it. It defines a small tag
 * language, resolves it against the template store, and hands the engine one flat string with no
 * trace of itself left in it. Whatever runs next — Pug, Nunjucks, React Email, anything — sees
 * only its own syntax, and its own `extends` / `include` are left untouched for it to deal with.
 *
 * ## The tags
 *
 * Every tag carries the `managed_` prefix, so nothing here can be mistaken for an engine tag
 * that is meant to survive composition. The prefix is configurable per composer, but it is
 * reserved: an unknown `{% managed_* %}` tag is a syntax error rather than text passed through,
 * which is what turns a typo into an error instead of into a broken email.
 *
 * - `{% managed_extends "base-email" %}` — this template is a child of `base-email`. At most one
 *   per template, at the top level (never inside a block). Takes an optional `version=2` to pin
 *   the parent.
 * - `{% managed_children %}` — in a parent: where the child's content goes. This is what makes a
 *   template *abstract*: it is a layout with a hole in it, filled by whatever the child writes
 *   outside its blocks. Rendered on its own, with no child, the hole is simply empty.
 * - `{% managed_block name %}...{% managed_endblock %}` — a named, overridable region. A
 *   parent's block renders its own content unless a child declares a block with the same name;
 *   the child's wins. Blocks may nest.
 * - `{% managed_super %}` — inside a child's block: the content of the block it is overriding.
 *   Chains through as many levels of inheritance as there are.
 * - `{% managed_include "footer" %}` — splice another template in at this point. The included
 *   template is composed in full first, so an include may itself extend and include.
 *
 * ## How a child fills a parent
 *
 * Everything the child writes *outside* a block is its children content, and it lands in the
 * parent's `{% managed_children %}`. Blocks are pulled out of that content first, so the two
 * mechanisms compose: a child can both fill the hole and override named regions.
 *
 * ```
 * parent "base-email"    <html><body>
 *                          {% managed_block header %}<h1>Acme</h1>{% managed_endblock %}
 *                          {% managed_children %}
 *                        </body></html>
 *
 * child  "welcome"       {% managed_extends "base-email" %}
 *                        {% managed_block header %}<h1>Welcome</h1>{% managed_endblock %}
 *                        <p>Hi #{name}</p>
 *
 * composed               <html><body>
 *                          <h1>Welcome</h1>
 *                          <p>Hi #{name}</p>
 *                        </body></html>
 * ```
 *
 * `#{name}` is untouched: composition never looks at engine syntax, and the context is the
 * engine's business.
 *
 * ## One field at a time
 *
 * A template carries three sources — body, subject and preheader — and each is composed against
 * the *same* field of the template it references. A child's body extends the parent's body; its
 * subject extends the parent's subject. So a base can define a subject prefix and a body wrapper
 * at once, and neither leaks into the other. A field the referenced template leaves empty
 * composes to nothing rather than to an error.
 *
 * ## Versions
 *
 * A reference with no `version=` resolves through the backend the same way any other read does:
 * to whatever version that key currently is. Pin it when a template must keep composing against
 * an exact parent — re-rendering an old notification resolves the child's version explicitly,
 * but its unpinned parents still resolve to today's.
 *
 * ## Cycles and depth
 *
 * A reference chain that comes back to a template already being composed throws
 * `ManagedTemplateCompositionCycleError` naming the chain, and a chain longer than `maxDepth`
 * throws `ManagedTemplateCompositionDepthError`. Neither can be caught by the engine
 * downstream, so both are found here rather than as a hang at send time.
 */

import { TEMPLATE_FIELDS, type TemplateField } from './constants.js';
import {
  ManagedTemplateCompositionCycleError,
  ManagedTemplateCompositionDepthError,
  ManagedTemplateCompositionReferenceError,
  ManagedTemplateCompositionSyntaxError,
  ManagedTemplateNotFoundError,
} from './errors.js';
import type { ManagedTemplate } from './types.js';

/**
 * Prefixed so a composition tag can never be confused with an engine tag meant to survive into
 * the rendered output. Configurable on a composer, but the whole prefix is reserved: unknown
 * tags carrying it are rejected instead of passed through.
 */
export const DEFAULT_TAG_PREFIX = 'managed_';

/**
 * How many references deep a single chain may go — extends and include both count, since both
 * resolve another template. High enough that no real layout hits it, low enough that a
 * pathological store fails fast instead of exhausting the stack.
 */
export const DEFAULT_MAX_DEPTH = 25;

/**
 * What `getTemplate` looks like from here: a key and an optional version in, one template out.
 * `BaseTemplateManagerBackend.getTemplate` satisfies it as it stands.
 */
export type TemplateResolver = (key: string, version: number | null) => Promise<ManagedTemplate>;

/** One direct reference from a template's field to another template. */
export type TemplateReference = {
  kind: 'extends' | 'include';
  key: string;
  version: number | null;
  field: TemplateField;
};

export type TemplateComposerOptions = {
  tagPrefix?: string;
  maxDepth?: number;
};

// ---------------------------------------------------------------------------------------------
// Parse tree
// ---------------------------------------------------------------------------------------------
//
// Composition is a tree walk rather than a chain of regex substitutions. Blocks nest, an
// override may itself contain blocks, and `{% managed_super %}` has to reach the definition one
// level up — all of which a substitution pass gets subtly wrong on the second level of
// inheritance.

type TextNode = { kind: 'text'; text: string };
type BlockNode = { kind: 'block'; name: string; body: Node[] };
/** The hole in an abstract template, filled by its child's out-of-block content. */
type ChildrenNode = { kind: 'children' };
/** The overridden definition of the block this node sits in. */
type SuperNode = { kind: 'super' };
type IncludeNode = { kind: 'include'; key: string; version: number | null };

type Node = TextNode | BlockNode | ChildrenNode | SuperNode | IncludeNode;

type Parsed = {
  extends: TemplateReference | null;
  nodes: Node[];
};

/**
 * A template's identity while it is being composed: what the cycle check compares and what error
 * messages name. Always the *resolved* version, never the requested one, so a chain that reaches
 * the same row by two different routes is still caught.
 */
type Origin = { key: string; version: number | null };

/**
 * Everything one `compose` call accumulates, shared by every field it composes.
 *
 * Kept per call rather than on the composer so a composer is safe to hold for the life of a
 * process: an edit to a base is picked up by the next render, not shadowed by a cache from the
 * last one.
 */
type Run = {
  templates: Map<string, ManagedTemplate>;
};

/** The tags that are structure rather than content, and take their line with them. */
const LINE_TAGS = new Set(['extends', 'block', 'endblock']);

const BLOCK_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const REFERENCE_ARGS = /^(["'])(.*?)\1(?:\s+version\s*=\s*(\d+))?$/;
const TRAILING_NEWLINE = /^[ \t]*\r?\n/;

function cacheKey(key: string, version: number | null): string {
  return `${key} ${version ?? ''}`;
}

function newRun(): Run {
  return { templates: new Map() };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const tagPatternCache = new Map<string, RegExp>();

/**
 * Every `{% <prefix><name> <args> %}` in a source, with its name and args split out.
 *
 * The args group accepts a bare `%` and stops only at `%}`, so a percent sign inside a key does
 * not end the tag early.
 */
function tagPattern(prefix: string): RegExp {
  const cached = tagPatternCache.get(prefix);
  if (cached) {
    // A fresh object per call: `lastIndex` is per-RegExp state and `matchAll` requires a
    // global pattern, so sharing one instance across nested parses would lose position.
    return new RegExp(cached.source, cached.flags);
  }
  const pattern = new RegExp(
    `\\{%\\s*${escapeRegExp(prefix)}(?<name>[a-z_]+)(?<args>(?:[^%]|%(?!\\}))*)%\\}`,
    'g',
  );
  tagPatternCache.set(prefix, pattern);
  return new RegExp(pattern.source, pattern.flags);
}

/** The chain a message points at: `'welcome' v1 -> 'base-email' v2`. */
function describe(stack: readonly Origin[]): string {
  return stack
    .map(({ key, version }) => (version === null ? `'${key}'` : `'${key}' v${version}`))
    .join(' -> ');
}

/** The `(in ...)` suffix every composition error carries. */
function at(stack: readonly Origin[], field: string): string {
  if (stack.length === 0) {
    return ` (in ${field})`;
  }
  return ` (in ${field} of ${describe(stack)})`;
}

/** How a tag's arguments read in an error message when there may not be any. */
function shown(args: string): string {
  return args ? JSON.stringify(args) : 'nothing';
}

/** Every node in the tree, blocks and their contents alike. */
function* walk(nodes: readonly Node[]): Generator<Node> {
  for (const node of nodes) {
    yield node;
    if (node.kind === 'block') {
      yield* walk(node.body);
    }
  }
}

/**
 * Every block a template declares, at any depth, by name.
 *
 * Nested ones are collected too, so a child can override a block that only exists inside another
 * block of the parent — and so a block a child nests inside one of its own is still available to
 * the level above. Names are unique per template, enforced at parse.
 */
function collectBlocks(nodes: readonly Node[]): Map<string, Node[]> {
  const blocks = new Map<string, Node[]>();
  for (const node of walk(nodes)) {
    if (node.kind === 'block') {
      blocks.set(node.name, node.body);
    }
  }
  return blocks;
}

/** A child's content minus its block declarations — what fills the parent's hole. */
function outsideBlocks(nodes: readonly Node[]): Node[] {
  return nodes.filter((node) => node.kind !== 'block');
}

/**
 * Definitions of one block, most derived first, ending in the one declared here.
 *
 * The head is what renders; the rest is what `{% managed_super %}` walks down.
 */
function chainFor(blocks: Map<string, Node[][]>, block: BlockNode): Node[][] {
  return [...(blocks.get(block.name) ?? []), block.body];
}

/**
 * The text between the last tag and this one, and where to resume after this one.
 *
 * Structural tags alone on their line are taken out *with* the line — the indentation in front
 * of them and the newline behind them — so a layout written across several lines does not
 * compose into one padded with blank ones. The placeholder tags (`children` / `include` /
 * `super`) are never line-trimmed: they stand where content goes, so what replaces them lands
 * exactly where the author put them, indentation and all.
 */
function textBefore(
  source: string,
  start: number,
  end: number,
  position: number,
  trimLine: boolean,
): { text: string; position: number } {
  const text = source.slice(position, start);
  if (!trimLine) {
    return { text, position: end };
  }

  const lineStart = start === 0 ? 0 : source.lastIndexOf('\n', start - 1) + 1;
  const alone = /^[ \t]*$/.test(source.slice(lineStart, start));
  const trailing = alone ? TRAILING_NEWLINE.exec(source.slice(end)) : null;

  if (trailing === null) {
    return { text, position: end };
  }

  const indent = Math.min(start - lineStart, text.length);
  return { text: text.slice(0, text.length - indent), position: end + trailing[0].length };
}

/** Resolves `managed_*` composition tags against a template store. */
export class TemplateComposer {
  readonly tagPrefix: string;

  readonly maxDepth: number;

  /**
   * @param resolveTemplate how a referenced key becomes a template — normally a backend's
   *   `getTemplate`. Left out, the composer still parses (so `references`, `isAbstract` and
   *   syntax checking work), but any template that actually references another throws
   *   `ManagedTemplateCompositionReferenceError`.
   * @param options `tagPrefix` — the reserved prefix every composition tag carries; change it
   *   only if `managed_` collides with something the engine downstream must receive verbatim.
   *   `maxDepth` — how many references deep one chain may go before it is called runaway.
   */
  constructor(
    private readonly resolveTemplate: TemplateResolver | null = null,
    options: TemplateComposerOptions = {},
  ) {
    this.tagPrefix = options.tagPrefix ?? DEFAULT_TAG_PREFIX;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /** A composer that resolves references through `backend.getTemplate`. */
  static fromBackend(
    backend: { getTemplate(key: string, version?: number | null): Promise<ManagedTemplate> },
    options: TemplateComposerOptions = {},
  ): TemplateComposer {
    return new TemplateComposer((key, version) => backend.getTemplate(key, version), options);
  }

  // -------------------------------------------------------------------------------------------
  // Composing
  // -------------------------------------------------------------------------------------------

  /**
   * Resolve every composition tag in a template, returning the flattened result.
   *
   * Each of the three sources is composed against the same field of whatever it references. The
   * template handed in is never mutated; a template with no composition tags in it is returned
   * as it stands, same object and all.
   */
  async compose(template: ManagedTemplate): Promise<ManagedTemplate> {
    const run = newRun();
    const origin: Origin = { key: template.key, version: template.version };
    const stack: Origin[] = [origin];
    run.templates.set(cacheKey(origin.key, origin.version), template);

    const body = template.bodyTemplate
      ? await this.composeInternal(template.bodyTemplate, 'bodyTemplate', stack, run)
      : template.bodyTemplate;

    const subject = template.subjectTemplate
      ? await this.composeInternal(template.subjectTemplate, 'subjectTemplate', stack, run)
      : template.subjectTemplate;

    const preheader = template.preheaderTemplate
      ? await this.composeInternal(template.preheaderTemplate, 'preheaderTemplate', stack, run)
      : template.preheaderTemplate;

    if (
      body === template.bodyTemplate &&
      subject === template.subjectTemplate &&
      preheader === template.preheaderTemplate
    ) {
      return template;
    }

    return {
      ...template,
      bodyTemplate: body,
      subjectTemplate: subject,
      preheaderTemplate: preheader,
    };
  }

  /**
   * Compose one source string that is not (yet) a stored template.
   *
   * This is the path for source in hand rather than in the store: an admin validating what was
   * typed into a form before saving it, a preview of an unsaved draft.
   *
   * Pass `key` (and `version`) when the source belongs to a template that exists, so a chain
   * that leads back to it is reported as the cycle it is instead of composing the stored — and
   * by then stale — copy of the very row being edited.
   */
  async composeSource(
    source: string,
    options: { field?: TemplateField; key?: string; version?: number | null } = {},
  ): Promise<string> {
    const field = options.field ?? 'bodyTemplate';
    const stack: Origin[] =
      options.key === undefined ? [] : [{ key: options.key, version: options.version ?? null }];
    return this.composeInternal(source, field, stack, newRun());
  }

  /** Compose a single field of a template, leaving the other two alone. */
  async composeField(template: ManagedTemplate, field: TemplateField): Promise<string | null> {
    const source = template[field];
    if (!source) {
      return source;
    }
    const run = newRun();
    const origin: Origin = { key: template.key, version: template.version };
    run.templates.set(cacheKey(origin.key, origin.version), template);
    return this.composeInternal(source, field, [origin], run);
  }

  /**
   * Compose the template and throw the result away, to surface any problem now.
   *
   * What an admin form or a deploy check calls: it throws exactly what rendering would have
   * thrown, at a point where someone can still fix it.
   */
  async validate(template: ManagedTemplate): Promise<void> {
    await this.compose(template);
  }

  // -------------------------------------------------------------------------------------------
  // Inspecting, without resolving anything
  // -------------------------------------------------------------------------------------------

  /**
   * Every template this one directly names, across all three fields.
   *
   * Direct only: what the references themselves reference is not followed, so this needs no
   * store and never throws for a missing template. Order is the order they appear, field by
   * field.
   */
  references(template: ManagedTemplate): TemplateReference[] {
    const found: TemplateReference[] = [];
    for (const field of TEMPLATE_FIELDS) {
      const source = template[field];
      if (!source) {
        continue;
      }
      found.push(...this.sourceReferences(source, field));
    }
    return found;
  }

  /** Every template one source string directly names. */
  sourceReferences(source: string, field: TemplateField = 'bodyTemplate'): TemplateReference[] {
    const parsed = this.parse(source, field, []);
    const found: TemplateReference[] = [];
    if (parsed.extends !== null) {
      found.push(parsed.extends);
    }
    for (const node of walk(parsed.nodes)) {
      if (node.kind === 'include') {
        found.push({ kind: 'include', key: node.key, version: node.version, field });
      }
    }
    return found;
  }

  /**
   * Whether this template is a base to build on rather than one to send.
   *
   * True when any of its fields declares a `{% managed_children %}` hole, or declares blocks
   * without extending anything — the two shapes that only make sense with a child underneath.
   * Nothing is stored: abstractness is a property of the source, so a template becomes abstract
   * the moment someone writes the hole into it and stops being abstract the moment they take it
   * out.
   *
   * Composing an abstract template directly is allowed and yields the layout with an empty hole.
   * Use this to keep one out of a picker where a *sendable* template is being chosen.
   */
  isAbstract(template: ManagedTemplate): boolean {
    return TEMPLATE_FIELDS.some((field) => this.sourceIsAbstract(template[field] ?? '', field));
  }

  /**
   * Whether one source string is a base to build on rather than one to send.
   *
   * The per-field half of {@link isAbstract}, for source in hand rather than a whole template.
   */
  sourceIsAbstract(source: string, field: TemplateField = 'bodyTemplate'): boolean {
    if (!source) {
      return false;
    }
    const parsed = this.parse(source, field, []);
    for (const node of walk(parsed.nodes)) {
      if (node.kind === 'children') {
        return true;
      }
    }
    if (parsed.extends !== null) {
      return false;
    }
    for (const node of walk(parsed.nodes)) {
      if (node.kind === 'block') {
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /**
   * Walk the inheritance chain from this source upwards, rendering once at the top.
   *
   * Overrides accumulate on the way up: each level's blocks are pushed *under* the ones already
   * collected, so the most derived definition stays at the head of every chain and
   * `{% managed_super %}` reaches the next one down it. The content each level writes outside its
   * blocks is rendered as it is passed, becoming the children of the level above — which is what
   * lets a middle template wrap its own child's content before handing it on.
   */
  private async composeInternal(
    source: string,
    field: TemplateField,
    stack: Origin[],
    run: Run,
  ): Promise<string> {
    let parsed = this.parse(source, field, stack);
    let currentStack = stack;
    const blocks = new Map<string, Node[][]>();
    let children = '';

    while (parsed.extends !== null) {
      const { template: parent, stack: parentStack } = await this.resolve(
        parsed.extends,
        currentStack,
        field,
        run,
      );
      children = await this.render(
        outsideBlocks(parsed.nodes),
        blocks,
        children,
        new Set(),
        [],
        field,
        currentStack,
        run,
      );
      for (const [name, body] of collectBlocks(parsed.nodes)) {
        const existing = blocks.get(name);
        if (existing) {
          existing.push(body);
        } else {
          blocks.set(name, [body]);
        }
      }

      currentStack = parentStack;
      parsed = this.parse(parent[field] ?? '', field, currentStack);
    }

    return this.render(parsed.nodes, blocks, children, new Set(), [], field, currentStack, run);
  }

  private async render(
    nodes: readonly Node[],
    blocks: Map<string, Node[][]>,
    children: string,
    active: ReadonlySet<string>,
    superChain: readonly Node[][],
    field: TemplateField,
    stack: readonly Origin[],
    run: Run,
  ): Promise<string> {
    const parts: string[] = [];

    for (const node of nodes) {
      if (node.kind === 'text') {
        parts.push(node.text);
      } else if (node.kind === 'children') {
        parts.push(children);
      } else if (node.kind === 'super') {
        // No definition left underneath means nothing to fall back to, which is what a
        // top-level block's super is: the empty string, not an error.
        if (superChain.length > 0) {
          parts.push(
            await this.render(
              superChain[0] as Node[],
              blocks,
              children,
              active,
              superChain.slice(1),
              field,
              stack,
              run,
            ),
          );
        }
      } else if (node.kind === 'include') {
        const reference: TemplateReference = {
          kind: 'include',
          key: node.key,
          version: node.version,
          field,
        };
        const { template: included, stack: includedStack } = await this.resolve(
          reference,
          stack,
          field,
          run,
        );
        parts.push(
          await this.composeInternal(included[field] ?? '', field, [...includedStack], run),
        );
      } else {
        // A block renders the most derived definition of its name, with the rest of the chain —
        // ending in the definition written here — available to super. Re-entering a name already
        // being rendered would loop, so inside itself a block is only ever its own definition.
        const chain = active.has(node.name) ? [node.body] : chainFor(blocks, node);
        const nextActive = new Set(active);
        nextActive.add(node.name);
        parts.push(
          await this.render(
            chain[0] as Node[],
            blocks,
            children,
            nextActive,
            chain.slice(1),
            field,
            stack,
            run,
          ),
        );
      }
    }

    return parts.join('');
  }

  /**
   * Fetch a referenced template and extend the chain with it.
   *
   * Cycles are compared on the *resolved* version rather than on the requested one, so a template
   * reached once by name and once by an explicit `version=` is recognized as the same row.
   */
  private async resolve(
    reference: TemplateReference,
    stack: readonly Origin[],
    field: TemplateField,
    run: Run,
  ): Promise<{ template: ManagedTemplate; stack: Origin[] }> {
    if (stack.length > this.maxDepth) {
      throw new ManagedTemplateCompositionDepthError(
        `Template composition went more than ${this.maxDepth} references deep${at(stack, field)}.`,
      );
    }

    if (this.resolveTemplate === null) {
      throw new ManagedTemplateCompositionReferenceError(
        `Cannot resolve '${reference.key}': this composer was built without a template ` +
          `resolver${at(stack, field)}.`,
      );
    }

    let cached = run.templates.get(cacheKey(reference.key, reference.version));
    if (cached === undefined) {
      try {
        cached = await this.resolveTemplate(reference.key, reference.version);
      } catch (error) {
        if (error instanceof ManagedTemplateNotFoundError) {
          const version = reference.version === null ? '' : ` v${reference.version}`;
          throw new ManagedTemplateCompositionReferenceError(
            `${reference.kind} references template '${reference.key}'${version}, ` +
              `which does not exist${at(stack, field)}.`,
          );
        }
        throw error;
      }
      run.templates.set(cacheKey(reference.key, reference.version), cached);
      // Also under the version it turned out to be, so a later reference that pins it explicitly
      // hits the same object — and is recognized as the same row by the cycle check below.
      const resolvedKey = cacheKey(cached.key, cached.version);
      if (!run.templates.has(resolvedKey)) {
        run.templates.set(resolvedKey, cached);
      }
    }

    const origin: Origin = { key: cached.key, version: cached.version };
    if (stack.some((entry) => entry.key === origin.key && entry.version === origin.version)) {
      throw new ManagedTemplateCompositionCycleError(
        `Template composition loops: ${describe([...stack, origin])} (in ${field}).`,
      );
    }
    return { template: cached, stack: [...stack, origin] };
  }

  /**
   * Turn a source string into a node tree, rejecting anything malformed.
   *
   * A tag sitting alone on its line takes the whole line with it — its indentation and the
   * newline after it — so a layout written to be readable does not compose into one full of
   * blank lines. A tag with content beside it is removed exactly, and the whitespace around it
   * is the author's.
   */
  private parse(source: string, field: TemplateField, stack: readonly Origin[]): Parsed {
    const pattern = tagPattern(this.tagPrefix);
    const root: Node[] = [];
    const openBlocks: { name: string; body: Node[] }[] = [];
    const declared = new Set<string>();
    let extendsReference: TemplateReference | null = null;
    let position = 0;

    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const current =
        openBlocks.length > 0 ? (openBlocks[openBlocks.length - 1] as { body: Node[] }).body : root;
      const name = match.groups?.name ?? '';
      const args = (match.groups?.args ?? '').trim();

      const before = textBefore(source, start, end, position, LINE_TAGS.has(name));
      position = before.position;
      if (before.text) {
        current.push({ kind: 'text', text: before.text });
      }

      if (name === 'extends') {
        if (openBlocks.length > 0) {
          throw this.syntax(`${this.tag('extends')} cannot appear inside a block`, field, stack);
        }
        if (extendsReference !== null) {
          throw this.syntax(
            `a template can only ${this.tag('extends')} one other template`,
            field,
            stack,
          );
        }
        const { key, version } = this.referenceArgs(args, 'extends', field, stack);
        extendsReference = { kind: 'extends', key, version, field };
      } else if (name === 'include') {
        const { key, version } = this.referenceArgs(args, 'include', field, stack);
        current.push({ kind: 'include', key, version });
      } else if (name === 'block') {
        const blockName = this.blockName(args, field, stack);
        if (declared.has(blockName)) {
          throw this.syntax(
            `block '${blockName}' is declared twice in the same template`,
            field,
            stack,
          );
        }
        declared.add(blockName);
        openBlocks.push({ name: blockName, body: [] });
      } else if (name === 'endblock') {
        const open = openBlocks.pop();
        if (open === undefined) {
          throw this.syntax(`${this.tag('endblock')} with no block open`, field, stack);
        }
        if (args && this.blockName(args, field, stack) !== open.name) {
          throw this.syntax(
            `${this.tag('endblock')} says '${args}' but the open block is '${open.name}'`,
            field,
            stack,
          );
        }
        const target =
          openBlocks.length > 0
            ? (openBlocks[openBlocks.length - 1] as { body: Node[] }).body
            : root;
        target.push({ kind: 'block', name: open.name, body: open.body });
      } else if (name === 'children') {
        this.expectNoArgs(args, 'children', field, stack);
        current.push({ kind: 'children' });
      } else if (name === 'super') {
        this.expectNoArgs(args, 'super', field, stack);
        current.push({ kind: 'super' });
      } else {
        throw this.syntax(
          `unknown composition tag ${this.tag(name)}. The '${this.tagPrefix}' prefix is ` +
            'reserved for composition, so this is not passed through to the engine',
          field,
          stack,
        );
      }
    }

    if (openBlocks.length > 0) {
      const open = openBlocks[openBlocks.length - 1] as { name: string };
      throw this.syntax(
        `block '${open.name}' is never closed with ${this.tag('endblock')}`,
        field,
        stack,
      );
    }

    const tail = source.slice(position);
    if (tail) {
      root.push({ kind: 'text', text: tail });
    }

    return { extends: extendsReference, nodes: root };
  }

  // -- parsing helpers ------------------------------------------------------------------------

  private tag(name: string): string {
    return `{% ${this.tagPrefix}${name} %}`;
  }

  private syntax(
    message: string,
    field: TemplateField,
    stack: readonly Origin[],
  ): ManagedTemplateCompositionSyntaxError {
    return new ManagedTemplateCompositionSyntaxError(`${message}${at(stack, field)}.`);
  }

  private referenceArgs(
    args: string,
    tag: string,
    field: TemplateField,
    stack: readonly Origin[],
  ): { key: string; version: number | null } {
    const match = REFERENCE_ARGS.exec(args);
    if (match === null || !(match[2] ?? '').trim()) {
      throw this.syntax(
        `${this.tag(tag)} takes a quoted template key, optionally followed by version=N — ` +
          `got ${shown(args)}`,
        field,
        stack,
      );
    }
    return {
      key: (match[2] as string).trim(),
      version: match[3] === undefined ? null : Number.parseInt(match[3], 10),
    };
  }

  private blockName(args: string, field: TemplateField, stack: readonly Origin[]): string {
    const name = args
      .replace(/^["']+/, '')
      .replace(/["']+$/, '')
      .trim();
    if (!BLOCK_NAME.test(name)) {
      throw this.syntax(
        `${this.tag('block')} takes a name starting with a letter or underscore — ` +
          `got ${shown(args)}`,
        field,
        stack,
      );
    }
    return name;
  }

  private expectNoArgs(
    args: string,
    tag: string,
    field: TemplateField,
    stack: readonly Origin[],
  ): void {
    if (args) {
      throw this.syntax(`${this.tag(tag)} takes no arguments — got ${shown(args)}`, field, stack);
    }
  }
}

/**
 * Whether a template is a base to build on rather than one to send.
 *
 * The store-free shortcut for `TemplateComposer.isAbstract`: abstractness is read off the
 * source, so no backend is needed to answer it. This is what a backend calls on every write to
 * keep `ManagedTemplate.isAbstract` in step with the sources.
 */
export function isAbstract(
  template: Pick<ManagedTemplate, TemplateField>,
  tagPrefix: string = DEFAULT_TAG_PREFIX,
): boolean {
  const composer = new TemplateComposer(null, { tagPrefix });
  return TEMPLATE_FIELDS.some((field) => composer.sourceIsAbstract(template[field] ?? '', field));
}
