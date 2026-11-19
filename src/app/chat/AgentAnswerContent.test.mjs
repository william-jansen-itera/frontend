import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from 'next-intl';
import { loadBindings, transform } from 'next/dist/build/swc/index.js';

const componentUrl = new URL('./AgentAnswerContent.js', import.meta.url);
await loadBindings();
const { code } = await transform(await readFile(componentUrl, 'utf8'), {
  filename: componentUrl.pathname,
  jsc: {
    parser: { syntax: 'ecmascript', jsx: true },
    transform: { react: { runtime: 'automatic' } },
    target: 'es2022',
  },
  module: { type: 'es6' },
});
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/image') {
      return { url: 'test:next-image', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:next-image') {
      return {
        format: 'module',
        source: `import image from ${JSON.stringify(import.meta.resolve('next/image.js'))}; export default image.default ?? image;`,
        shortCircuit: true,
      };
    }
    if (url === componentUrl.href) {
      return { format: 'module', source: code, shortCircuit: true };
    }
    if (url === new URL('./page.module.css', import.meta.url).href) {
      return { format: 'module', source: 'export default {};', shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { AgentAnswerContent } = await import(componentUrl.href);
hooks.deregister();

async function renderAnswer(answer, language) {
  const messages = JSON.parse(await readFile(new URL(`../language/${language}.json`, import.meta.url), 'utf8'));
  return renderToStaticMarkup(createElement(AgentAnswerContent, {
    answer,
    translate: createTranslator({ locale: language, messages, namespace: 'Pages.Chat' }),
  }));
}

test('saved note and attachment links display Danish labels without changing their destinations', async () => {
  const html = await renderAnswer(
    '[View note](/notes?treeId=29&nodeId=4&visibility=private)\n\n[View attachment](/notes?treeId=29&nodeId=5&visibility=public)',
    'da',
  );
  assert.match(html, /href="\/notes\?treeId=29&amp;nodeId=4&amp;visibility=private"[^>]*>Vis note<\/a>/);
  assert.match(html, /href="\/notes\?treeId=29&amp;nodeId=5&amp;visibility=public"[^>]*>Vis vedhæftning<\/a>/);
});

test('saved links retain English labels for an English response', async () => {
  const html = await renderAnswer('[View note](/notes?treeId=29&nodeId=4)\n\n[View attachment](/notes?treeId=29&nodeId=5)', 'en');
  assert.match(html, />View note<\/a>/);
  assert.match(html, />View attachment<\/a>/);
});

test('localizing saved links does not translate saved prose, custom labels, or external links', async () => {
  const html = await renderAnswer(
    'View note\n\n[My saved title](/notes?treeId=29&nodeId=4)\n\n[View note](https://example.com/notes?treeId=29)',
    'da',
  );
  assert.match(html, /<p>View note<\/p>/);
  assert.match(html, />My saved title<\/a>/);
  assert.match(html, /href="https:\/\/example.com\/notes\?treeId=29"[^>]*>View note<\/a>/);
});

test('ordinary image attachment links become previews before Markdown rendering and URL rewriting', async () => {
  const blobUrl = 'https://storage.blob.core.windows.net/node-attachments/notes/7/216/sole.jpg';
  const html = await renderAnswer(
    `Sole-view diagram: [${blobUrl}](${blobUrl})\n\n- Hoof wall: [**Hoof wall**](https://storage.blob.core.windows.net/node-attachments/notes/7/216/wall.jpeg)`,
    'en',
  );
  assert.equal((html.match(/<img /g) ?? []).length, 2);
  assert.match(html, /<img [^>]*alt="sole.jpg"[^>]*src="\/api\/attachments\/content\?blobName=notes%2F7%2F216%2Fsole.jpg"/);
  assert.match(html, /<img [^>]*alt="Hoof wall"[^>]*src="\/api\/attachments\/content\?blobName=notes%2F7%2F216%2Fwall.jpeg"/);
  assert.doesNotMatch(html, /storage\.blob\.core\.windows\.net/);
  assert.doesNotMatch(html, />sole\.jpg</);
  assert.doesNotMatch(html, /<p>(?:(?!<\/p>)[\s\S])*?<div/);
});

test('existing Markdown images and already rewritten attachment links both retain their previews', async () => {
  const html = await renderAnswer(
    '![Original image](https://storage.blob.core.windows.net/node-attachments/notes/7/216/original.png)\n\n[API image](/api/attachments/content?blobName=notes%2F7%2F216%2Frewritten.jpg)',
    'en',
  );
  assert.equal((html.match(/<img /g) ?? []).length, 2);
  assert.match(html, /src="\/api\/attachments\/content\?blobName=notes%2F7%2F216%2Foriginal.png"/);
  assert.match(html, /src="\/api\/attachments\/content\?blobName=notes%2F7%2F216%2Frewritten.jpg"/);
});

test('document attachments and external image links remain links without allowing unsafe URLs', async () => {
  const html = await renderAnswer(
    '[Document](https://storage.blob.core.windows.net/node-attachments/notes/7/216/document.pdf)\n\n[External image](https://example.com/image.jpg)\n\n[Unsafe](javascript:alert)',
    'en',
  );
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /href="\/api\/attachments\/content\?blobName=notes%2F7%2F216%2Fdocument.pdf"/);
  assert.match(html, /href="https:\/\/example.com\/image.jpg"/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test('image preview open commands use the shared external-link icon button with a translated label', async () => {
  const html = await renderAnswer(
    '![Diagram](https://storage.blob.core.windows.net/node-attachments/notes/7/216/diagram.jpg)',
    'da',
  );
  assert.match(html, /<a [^>]*href="\/api\/attachments\/content\?blobName=notes%2F7%2F216%2Fdiagram.jpg"[^>]*target="_blank"[^>]*class="appIconButton appCompactActionButton appCompactActionButtonNeutral"[^>]*title="Åbn"[^>]*aria-label="Åbn"/);
  assert.match(html, /<svg [^>]*width="20"[^>]*height="20"[^>]*class="[^"]*lucide-external-link/);
});
