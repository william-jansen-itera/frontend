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
    return nextResolve(specifier === 'next/image' ? 'next/image.js' : specifier, context);
  },
  load(url, context, nextLoad) {
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
