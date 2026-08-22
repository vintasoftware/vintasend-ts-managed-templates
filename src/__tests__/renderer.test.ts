import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryTemplateManagerBackend } from '../in-memory-template-manager-backend.js';
import {
  ManagedTemplateEmailRenderer,
  ManagedTemplateTextRenderer,
  requestedTemplateVersion,
} from '../managed-template-renderer.js';
import type { ManagedTemplateCreateInput } from '../types.js';
import { makeManagedEmailRenderer, makeNotification, type TestConfig } from './fakes.js';

function createInput(
  key: string,
  overrides: Partial<ManagedTemplateCreateInput> = {},
): ManagedTemplateCreateInput {
  return {
    key,
    name: key,
    description: '',
    templateManagedBackend: 'in-memory',
    bodyTemplate: '<p>Hi {name}</p>',
    subjectTemplate: 'Welcome',
    preheaderTemplate: null,
    tenant: null,
    ...overrides,
  };
}

let backend: InMemoryTemplateManagerBackend;

beforeEach(() => {
  backend = new InMemoryTemplateManagerBackend();
});

describe('rendering a stored template', () => {
  it('reads the template behind the key and renders it', async () => {
    await backend.createTemplate(createInput('welcome'));
    const { renderer } = makeManagedEmailRenderer(backend);

    const rendered = await renderer.render(makeNotification('welcome'), { name: 'Ana' });

    // `templateVersion` rides along on the payload: that is the channel VintaSend reads it
    // through, since an adapter returns the payload from `send()` and nothing richer.
    expect(rendered).toEqual({
      subject: 'Welcome',
      body: '<p>Hi Ana</p>',
      templateVersion: 1,
    });
  });

  it('stamps the version that rendered onto the payload', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.updateTemplate('welcome', { bodyTemplate: 'v2' });
    const { renderer } = makeManagedEmailRenderer(backend);

    const latest = await renderer.render(makeNotification('welcome'), {});
    const pinned = await renderer.render(makeNotification('welcome', 1), {});

    expect(latest.templateVersion).toBe(2);
    expect(pinned.templateVersion).toBe(1);
  });

  it('reports which version rendered', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.updateTemplate('welcome', { bodyTemplate: 'v2' });
    const { renderer } = makeManagedEmailRenderer(backend);

    const result = await renderer.renderManaged(makeNotification('welcome'), {});

    expect(result).toMatchObject({ key: 'welcome', version: 2 });
  });

  it("honours a notification's own version pin", async () => {
    await backend.createTemplate(createInput('welcome', { bodyTemplate: 'v1' }));
    await backend.updateTemplate('welcome', { bodyTemplate: 'v2' });
    const { renderer } = makeManagedEmailRenderer(backend);

    const result = await renderer.renderManaged(makeNotification('welcome', 1), {});

    expect(result.version).toBe(1);
    expect(result.rendered.body).toBe('v1');
  });

  it('lets an explicit version override even the pin, which is what previewing a draft needs', async () => {
    await backend.createTemplate(createInput('welcome', { bodyTemplate: 'v1' }));
    await backend.updateTemplate('welcome', { bodyTemplate: 'draft' });
    const { renderer } = makeManagedEmailRenderer(backend);

    const result = await renderer.renderManaged(makeNotification('welcome', 1), {}, 2);

    expect(result.rendered.body).toBe('draft');
  });

  it('composes before the inner renderer sees the template', async () => {
    await backend.createTemplate(
      createInput('base', { bodyTemplate: '<html>{% managed_children %}</html>' }),
    );
    await backend.createTemplate(
      createInput('welcome', { bodyTemplate: '{% managed_extends "base" %}<p>Hi</p>' }),
    );
    const { renderer, inner } = makeManagedEmailRenderer(backend);

    await renderer.render(makeNotification('welcome'), {});

    expect(inner.contents[0]?.body).toBe('<html><p>Hi</p></html>');
  });

  it('hands the store contents through verbatim when composition is off', async () => {
    await backend.createTemplate(
      createInput('welcome', { bodyTemplate: '{% managed_children %}' }),
    );
    const renderer = new ManagedTemplateEmailRenderer<TestConfig>(
      backend,
      makeManagedEmailRenderer(backend).inner,
      { composeTemplates: false },
    );

    const rendered = await renderer.render(makeNotification('welcome'), {});

    expect(rendered.body).toBe('{% managed_children %}');
  });

  it('carries the preheader alongside subject and body', async () => {
    await backend.createTemplate(createInput('welcome', { preheaderTemplate: 'see inside' }));
    const { renderer, inner } = makeManagedEmailRenderer(backend);

    await renderer.render(makeNotification('welcome'), {});

    expect(inner.contents[0]?.preheader).toBe('see inside');
  });
});

describe('getLatestTemplateVersion', () => {
  it('answers with the version a bare render would resolve to', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.updateTemplate('welcome', {});
    const { renderer } = makeManagedEmailRenderer(backend);

    expect(await renderer.getLatestTemplateVersion('welcome')).toBe(2);
  });

  it('answers null for a key with nothing behind it, rather than failing a creation', async () => {
    const { renderer } = makeManagedEmailRenderer(backend);

    expect(await renderer.getLatestTemplateVersion('nope')).toBeNull();
  });
});

describe('text channels', () => {
  it('feeds only the body to a text renderer', async () => {
    await backend.createTemplate(createInput('sms', { bodyTemplate: 'Code: {code}' }));
    const contents: { text: string }[] = [];
    const inner = {
      renderFromTemplateContent: async (
        _notification: unknown,
        content: { text: string },
      ): Promise<{ text: string }> => {
        contents.push(content);
        return { text: content.text };
      },
      render: async () => ({ text: '' }),
    };
    const renderer = new ManagedTemplateTextRenderer<TestConfig>(backend, inner as never);

    await renderer.render(makeNotification('sms'), { code: '123' });

    expect(contents[0]).toEqual({ text: 'Code: {code}' });
  });
});

describe('requestedTemplateVersion', () => {
  it('reads a pin off whatever carries one', () => {
    expect(requestedTemplateVersion({ requestedTemplateVersion: 3 })).toBe(3);
  });

  it('answers null for a notification that carries none', () => {
    expect(requestedTemplateVersion({})).toBeNull();
    expect(requestedTemplateVersion(null)).toBeNull();
    expect(requestedTemplateVersion({ requestedTemplateVersion: null })).toBeNull();
  });
});
