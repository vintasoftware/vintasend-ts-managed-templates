/**
 * Composition: what the engine ends up with once inheritance and inclusion are resolved.
 *
 * Every test here drives `TemplateComposer` against a dict of templates, because what is under
 * test is the tag language rather than any store.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { isAbstract, TemplateComposer } from '../composition.js';
import {
  isNotFoundError,
  ManagedTemplateCompositionCycleError,
  ManagedTemplateCompositionDepthError,
  ManagedTemplateCompositionError,
  ManagedTemplateCompositionReferenceError,
  ManagedTemplateCompositionSyntaxError,
} from '../errors.js';
import { DictStore, makeTemplate } from './helpers.js';

let store: DictStore;
let composer: TemplateComposer;

beforeEach(() => {
  store = new DictStore();
  composer = new TemplateComposer(store.getTemplate);
});

describe('inheritance', () => {
  it('lets a child fill the hole its parent left', async () => {
    store.add(makeTemplate('base', '<body>{% managed_children %}</body>'));
    const child = store.add(makeTemplate('welcome', '{% managed_extends "base" %}<p>Hi</p>'));

    expect((await composer.compose(child)).bodyTemplate).toBe('<body><p>Hi</p></body>');
  });

  it('renders a parent with no child as an empty hole', async () => {
    const base = store.add(makeTemplate('base', '<body>{% managed_children %}</body>'));

    expect((await composer.compose(base)).bodyTemplate).toBe('<body></body>');
  });

  it('renders a block with what it was declared with when nothing overrides it', async () => {
    store.add(makeTemplate('base', '{% managed_block title %}Acme{% managed_endblock %}!'));
    const child = store.add(makeTemplate('welcome', '{% managed_extends "base" %}'));

    expect((await composer.compose(child)).bodyTemplate).toBe('Acme!');
  });

  it("lets a child's block win over its parent's", async () => {
    store.add(makeTemplate('base', '{% managed_block title %}Acme{% managed_endblock %}!'));
    const child = store.add(
      makeTemplate(
        'welcome',
        '{% managed_extends "base" %}{% managed_block title %}Hi{% managed_endblock %}',
      ),
    );

    expect((await composer.compose(child)).bodyTemplate).toBe('Hi!');
  });

  it('composes blocks and children together', async () => {
    store.add(
      makeTemplate(
        'base',
        '[{% managed_block title %}Acme{% managed_endblock %}]{% managed_children %}',
      ),
    );
    const child = store.add(
      makeTemplate(
        'welcome',
        '{% managed_extends "base" %}{% managed_block title %}Hi{% managed_endblock %}<p>body</p>',
      ),
    );

    expect((await composer.compose(child)).bodyTemplate).toBe('[Hi]<p>body</p>');
  });

  it('drops a block the parent never declared', async () => {
    store.add(makeTemplate('base', '[{% managed_children %}]'));
    const child = store.add(
      makeTemplate(
        'welcome',
        '{% managed_extends "base" %}{% managed_block nowhere %}x{% managed_endblock %}body',
      ),
    );

    expect((await composer.compose(child)).bodyTemplate).toBe('[body]');
  });

  it('lets a nested block be overridden on its own', async () => {
    store.add(
      makeTemplate(
        'base',
        '{% managed_block outer %}<div>{% managed_block inner %}in{% managed_endblock %}</div>{% managed_endblock %}',
      ),
    );
    const child = store.add(
      makeTemplate(
        'welcome',
        '{% managed_extends "base" %}{% managed_block inner %}INNER{% managed_endblock %}',
      ),
    );

    expect((await composer.compose(child)).bodyTemplate).toBe('<div>INNER</div>');
  });

  it('chains inheritance through three levels', async () => {
    store.add(makeTemplate('base', '<html>{% managed_children %}</html>'));
    store.add(
      makeTemplate('layout', '{% managed_extends "base" %}<body>{% managed_children %}</body>'),
    );
    const child = store.add(makeTemplate('welcome', '{% managed_extends "layout" %}<p>Hi</p>'));

    expect((await composer.compose(child)).bodyTemplate).toBe(
      '<html><body><p>Hi</p></body></html>',
    );
  });

  it('pulls the overridden block in with super', async () => {
    store.add(makeTemplate('base', '{% managed_block title %}Acme{% managed_endblock %}'));
    const child = store.add(
      makeTemplate(
        'welcome',
        '{% managed_extends "base" %}{% managed_block title %}{% managed_super %} — Welcome{% managed_endblock %}',
      ),
    );

    expect((await composer.compose(child)).bodyTemplate).toBe('Acme — Welcome');
  });

  it('walks super down every level that declared the block', async () => {
    store.add(makeTemplate('base', '{% managed_block trail %}a{% managed_endblock %}'));
    store.add(
      makeTemplate(
        'layout',
        '{% managed_extends "base" %}{% managed_block trail %}{% managed_super %}b{% managed_endblock %}',
      ),
    );
    const child = store.add(
      makeTemplate(
        'welcome',
        '{% managed_extends "layout" %}{% managed_block trail %}{% managed_super %}c{% managed_endblock %}',
      ),
    );

    expect((await composer.compose(child)).bodyTemplate).toBe('abc');
  });

  it('renders nothing for a super with nothing underneath it', async () => {
    const base = store.add(
      makeTemplate('base', '[{% managed_block title %}{% managed_super %}{% managed_endblock %}]'),
    );

    expect((await composer.compose(base)).bodyTemplate).toBe('[]');
  });

  it('does not recurse when a block declares its own name', async () => {
    store.add(makeTemplate('base', '{% managed_block title %}base{% managed_endblock %}'));
    const child = store.add(
      makeTemplate(
        'welcome',
        '{% managed_extends "base" %}{% managed_block title %}<h1>{% managed_super %}</h1>{% managed_endblock %}',
      ),
    );

    expect((await composer.compose(child)).bodyTemplate).toBe('<h1>base</h1>');
  });
});

describe('inclusion', () => {
  it('splices another template in', async () => {
    store.add(makeTemplate('footer', '<footer>bye</footer>'));
    const page = store.add(makeTemplate('page', 'body{% managed_include "footer" %}'));

    expect((await composer.compose(page)).bodyTemplate).toBe('body<footer>bye</footer>');
  });

  it('composes an include before splicing it', async () => {
    store.add(makeTemplate('wrapper', '<i>{% managed_children %}</i>'));
    store.add(makeTemplate('footer', '{% managed_extends "wrapper" %}bye'));
    const page = store.add(makeTemplate('page', '{% managed_include "footer" %}'));

    expect((await composer.compose(page)).bodyTemplate).toBe('<i>bye</i>');
  });

  it('resolves an include inside a block', async () => {
    store.add(makeTemplate('logo', '[logo]'));
    store.add(
      makeTemplate(
        'base',
        '{% managed_block head %}{% managed_include "logo" %}{% managed_endblock %}',
      ),
    );
    const child = store.add(makeTemplate('welcome', '{% managed_extends "base" %}'));

    expect((await composer.compose(child)).bodyTemplate).toBe('[logo]');
  });

  it('allows the same template to be included twice', async () => {
    store.add(makeTemplate('rule', '<hr>'));
    const page = store.add(
      makeTemplate('page', 'a{% managed_include "rule" %}b{% managed_include "rule" %}c'),
    );

    expect((await composer.compose(page)).bodyTemplate).toBe('a<hr>b<hr>c');
  });
});

describe('fields and versions', () => {
  it('composes each field against the same field of its parent', async () => {
    store.add(
      makeTemplate('base', '<body>{% managed_children %}</body>', {
        subjectTemplate: '[Acme] {% managed_children %}',
        preheaderTemplate: 'pre: {% managed_children %}',
      }),
    );
    const child = store.add(
      makeTemplate('welcome', '{% managed_extends "base" %}<p>Hi</p>', {
        subjectTemplate: '{% managed_extends "base" %}Welcome',
        preheaderTemplate: '{% managed_extends "base" %}now',
      }),
    );

    const composed = await composer.compose(child);

    expect(composed.bodyTemplate).toBe('<body><p>Hi</p></body>');
    expect(composed.subjectTemplate).toBe('[Acme] Welcome');
    expect(composed.preheaderTemplate).toBe('pre: now');
  });

  it('composes a field the parent leaves empty to nothing', async () => {
    store.add(makeTemplate('base', '<body>{% managed_children %}</body>'));
    const child = store.add(
      makeTemplate('welcome', 'body', { subjectTemplate: '{% managed_extends "base" %}Hi' }),
    );

    expect((await composer.compose(child)).subjectTemplate).toBe('');
  });

  it('leaves a field with no source alone', async () => {
    const child = store.add(
      makeTemplate('welcome', 'body', { subjectTemplate: null, preheaderTemplate: '' }),
    );

    const composed = await composer.compose(child);

    expect(composed.subjectTemplate).toBeNull();
    expect(composed.preheaderTemplate).toBe('');
  });

  it('resolves a reference to the latest version by default', async () => {
    store.add(makeTemplate('base', 'v1:{% managed_children %}', { version: 1 }));
    store.add(makeTemplate('base', 'v2:{% managed_children %}', { version: 2 }));
    const child = store.add(makeTemplate('welcome', '{% managed_extends "base" %}Hi'));

    expect((await composer.compose(child)).bodyTemplate).toBe('v2:Hi');
    expect(store.reads).toContainEqual({ key: 'base', version: null });
  });

  it('lets a reference pin the version it composes against', async () => {
    store.add(makeTemplate('base', 'v1:{% managed_children %}', { version: 1 }));
    store.add(makeTemplate('base', 'v2:{% managed_children %}', { version: 2 }));
    const child = store.add(makeTemplate('welcome', '{% managed_extends "base" version=1 %}Hi'));

    expect((await composer.compose(child)).bodyTemplate).toBe('v1:Hi');
    expect(store.reads).toContainEqual({ key: 'base', version: 1 });
  });

  it('hands a template with nothing to compose straight back', async () => {
    const plain = store.add(makeTemplate('plain', '<p>#{name}</p>', { subjectTemplate: 'Hi' }));

    expect(await composer.compose(plain)).toBe(plain);
  });

  it('never touches the template it was given', async () => {
    store.add(makeTemplate('base', '[{% managed_children %}]'));
    const child = store.add(makeTemplate('welcome', '{% managed_extends "base" %}Hi'));
    const before = { ...child };

    await composer.compose(child);

    expect(child).toEqual(before);
  });

  it('carries engine syntax through untouched', async () => {
    store.add(makeTemplate('base', '{% block other %}{% managed_children %}{% endblock %}'));
    const child = store.add(
      makeTemplate('welcome', '{% managed_extends "base" %}{% if x %}{{ y|safe }}{% endif %}'),
    );

    expect((await composer.compose(child)).bodyTemplate).toBe(
      '{% block other %}{% if x %}{{ y|safe }}{% endif %}{% endblock %}',
    );
  });
});

describe('whitespace', () => {
  it('takes the line with a structural tag that sits alone on it', async () => {
    store.add(
      makeTemplate(
        'base',
        '<html>\n    {% managed_block body %}\n    <p>default</p>\n    {% managed_endblock %}\n</html>',
      ),
    );
    const child = store.add(makeTemplate('welcome', '{% managed_extends "base" %}\n'));

    expect((await composer.compose(child)).bodyTemplate).toBe(
      '<html>\n    <p>default</p>\n</html>',
    );
  });

  it('replaces a placeholder tag exactly where it stands', async () => {
    store.add(makeTemplate('base', '<html>\n  {% managed_children %}\n</html>'));
    const child = store.add(makeTemplate('welcome', '{% managed_extends "base" %}<p>Hi</p>'));

    expect((await composer.compose(child)).bodyTemplate).toBe('<html>\n  <p>Hi</p>\n</html>');
  });

  it('leaves content beside a tag alone', async () => {
    store.add(makeTemplate('base', 'a {% managed_children %} b'));
    const child = store.add(makeTemplate('welcome', '{% managed_extends "base" %}Hi'));

    expect((await composer.compose(child)).bodyTemplate).toBe('a Hi b');
  });
});

describe('broken references', () => {
  it('names the template that does not exist', async () => {
    const child = store.add(makeTemplate('welcome', '{% managed_extends "nope" %}Hi'));

    await expect(composer.compose(child)).rejects.toThrow(ManagedTemplateCompositionReferenceError);
    await expect(composer.compose(child)).rejects.toThrow(/'nope'/);
    await expect(composer.compose(child)).rejects.toThrow(/'welcome' v1/);
  });

  it('reports a missing reference as a missing template too', async () => {
    const child = store.add(makeTemplate('welcome', '{% managed_include "nope" %}'));

    await expect(composer.compose(child)).rejects.toSatisfy(isNotFoundError);
  });

  it('says which version a missing pinned reference wanted', async () => {
    store.add(makeTemplate('base', '[{% managed_children %}]'));
    const child = store.add(makeTemplate('welcome', '{% managed_extends "base" version=7 %}Hi'));

    await expect(composer.compose(child)).rejects.toThrow(/v7/);
  });

  it('says so when the composer has no resolver', async () => {
    const child = makeTemplate('welcome', '{% managed_extends "base" %}Hi');

    await expect(new TemplateComposer().compose(child)).rejects.toThrow(/resolver/);
  });

  it('still parses without a resolver', async () => {
    const plain = makeTemplate('welcome', '{% managed_block a %}x{% managed_endblock %}');

    expect((await new TemplateComposer().compose(plain)).bodyTemplate).toBe('x');
  });
});

describe('cycles and depth', () => {
  it('catches two templates extending each other', async () => {
    const first = store.add(makeTemplate('first', '{% managed_extends "second" %}'));
    store.add(makeTemplate('second', '{% managed_extends "first" %}'));

    await expect(composer.compose(first)).rejects.toThrow(ManagedTemplateCompositionCycleError);
    await expect(composer.compose(first)).rejects.toThrow(
      /'first' v1 -> 'second' v1 -> 'first' v1/,
    );
  });

  it('catches a template that includes itself', async () => {
    const page = store.add(makeTemplate('page', 'a{% managed_include "page" %}'));

    await expect(composer.compose(page)).rejects.toThrow(ManagedTemplateCompositionCycleError);
  });

  it('catches a cycle reached through a pinned version', async () => {
    const first = store.add(makeTemplate('first', '{% managed_extends "second" %}'));
    store.add(makeTemplate('second', '{% managed_extends "first" version=1 %}'));

    await expect(composer.compose(first)).rejects.toThrow(ManagedTemplateCompositionCycleError);
  });

  it('refuses a chain longer than maxDepth', async () => {
    const depth = 4;
    store.add(makeTemplate('level-0', 'end'));
    for (let level = 1; level <= depth + 2; level += 1) {
      store.add(makeTemplate(`level-${level}`, `{% managed_extends "level-${level - 1}" %}`));
    }
    const deep = new TemplateComposer(store.getTemplate, { maxDepth: depth });

    await expect(
      deep.compose(store.templates.get(`level-${depth + 2}@1`) as never),
    ).rejects.toThrow(ManagedTemplateCompositionDepthError);
  });
});

describe('malformed tags', () => {
  const cases: [string, RegExp][] = [
    ['{% managed_block %}x{% managed_endblock %}', /takes a name/],
    ['{% managed_block 9lives %}x{% managed_endblock %}', /takes a name/],
    ['{% managed_block a %}x', /never closed/],
    ['{% managed_endblock %}', /no block open/],
    ['{% managed_block a %}x{% managed_endblock b %}', /the open block is 'a'/],
    [
      '{% managed_block a %}x{% managed_endblock %}{% managed_block a %}y{% managed_endblock %}',
      /declared twice/,
    ],
    ['{% managed_extends base %}', /quoted template key/],
    ['{% managed_extends %}', /quoted template key/],
    ['{% managed_extends "" %}', /quoted template key/],
    ['{% managed_include "a" version=x %}', /quoted template key/],
    ['{% managed_extends "a" %}{% managed_extends "b" %}', /can only .* one other template/],
    [
      '{% managed_block a %}{% managed_extends "b" %}{% managed_endblock %}',
      /cannot appear inside a block/,
    ],
    ['{% managed_children yes %}', /takes no arguments/],
    ['{% managed_super loud %}', /takes no arguments/],
    ['{% managed_frobnicate %}', /unknown composition tag/],
  ];

  it.each(cases)('reports what is wrong with %s', async (source, message) => {
    const template = store.add(makeTemplate('broken', source));

    await expect(composer.compose(template)).rejects.toThrow(ManagedTemplateCompositionSyntaxError);
    await expect(composer.compose(template)).rejects.toThrow(message);
    await expect(composer.compose(template)).rejects.toThrow(/bodyTemplate/);
  });

  it('shares one base class across every composition failure', async () => {
    const template = store.add(makeTemplate('broken', '{% managed_endblock %}'));

    await expect(composer.compose(template)).rejects.toThrow(ManagedTemplateCompositionError);
  });

  it('accepts a quoted block name', async () => {
    const template = store.add(
      makeTemplate('t', '{% managed_block "a" %}x{% managed_endblock "a" %}'),
    );

    expect((await composer.compose(template)).bodyTemplate).toBe('x');
  });

  it('names a template with single quotes too', async () => {
    store.add(makeTemplate('footer', 'bye'));
    const page = store.add(makeTemplate('page', "{% managed_include 'footer' %}"));

    expect((await composer.compose(page)).bodyTemplate).toBe('bye');
  });
});

describe('inspecting a template', () => {
  it('lists what a template names', () => {
    const template = makeTemplate(
      'welcome',
      '{% managed_extends "base" %}{% managed_include "footer" version=3 %}',
      { subjectTemplate: '{% managed_include "prefix" %}' },
    );

    expect(composer.references(template)).toEqual([
      { kind: 'extends', key: 'base', version: null, field: 'bodyTemplate' },
      { kind: 'include', key: 'footer', version: 3, field: 'bodyTemplate' },
      { kind: 'include', key: 'prefix', version: null, field: 'subjectTemplate' },
    ]);
  });

  it('needs none of them to exist', () => {
    const template = makeTemplate('welcome', '{% managed_extends "missing" %}');

    expect(composer.references(template)[0]?.key).toBe('missing');
  });

  it('reports no references for a plain template', () => {
    expect(composer.references(makeTemplate('plain', 'hi', { subjectTemplate: 'hi' }))).toEqual([]);
  });

  it('calls a template with a hole abstract', () => {
    expect(composer.isAbstract(makeTemplate('base', '<body>{% managed_children %}</body>'))).toBe(
      true,
    );
  });

  it('calls a template with blocks and no parent abstract', () => {
    expect(
      composer.isAbstract(makeTemplate('base', '{% managed_block a %}x{% managed_endblock %}')),
    ).toBe(true);
  });

  it('does not call a template that only overrides blocks abstract', () => {
    expect(
      composer.isAbstract(
        makeTemplate(
          'welcome',
          '{% managed_extends "base" %}{% managed_block a %}x{% managed_endblock %}',
        ),
      ),
    ).toBe(false);
  });

  it('does not call a plain template abstract', () => {
    expect(composer.isAbstract(makeTemplate('plain', '<p>hi</p>', { subjectTemplate: 'hi' }))).toBe(
      false,
    );
  });

  it('reads abstractness off any field', () => {
    expect(
      composer.isAbstract(
        makeTemplate('base', 'body', { subjectTemplate: '{% managed_children %}' }),
      ),
    ).toBe(true);
  });

  it('answers isAbstract without a store', () => {
    expect(isAbstract(makeTemplate('base', '{% managed_children %}'))).toBe(true);
    expect(isAbstract(makeTemplate('plain', 'hi'))).toBe(false);
  });
});

describe('composing loose source', () => {
  it('composes source before it is stored', async () => {
    store.add(makeTemplate('base', '[{% managed_children %}]'));

    expect(await composer.composeSource('{% managed_extends "base" %}draft')).toBe('[draft]');
  });

  it('catches a chain that leads back to the source being edited', async () => {
    store.add(makeTemplate('base', '{% managed_extends "welcome" %}'));
    store.add(makeTemplate('welcome', 'stale'));

    await expect(
      composer.composeSource('{% managed_extends "base" %}draft', {
        key: 'welcome',
        version: 1,
      }),
    ).rejects.toThrow(ManagedTemplateCompositionCycleError);
  });

  it('composes a single field of a template', async () => {
    store.add(makeTemplate('base', '[{% managed_children %}]'));
    const child = makeTemplate('welcome', '{% managed_extends "base" %}body', {
      subjectTemplate: 'untouched',
    });

    expect(await composer.composeField(child, 'bodyTemplate')).toBe('[body]');
    expect(await composer.composeField(child, 'subjectTemplate')).toBe('untouched');
  });

  it('uses a custom tag prefix when asked', async () => {
    const custom = new TemplateComposer(store.getTemplate, { tagPrefix: 'vs_' });
    store.add(makeTemplate('base', '[{% vs_children %}]'));
    const child = makeTemplate('welcome', '{% vs_extends "base" %}Hi');

    expect((await custom.compose(child)).bodyTemplate).toBe('[Hi]');
  });
});
