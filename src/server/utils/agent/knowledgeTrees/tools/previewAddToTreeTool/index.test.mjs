import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const exportsByModule = {
  treeMutationService: ['previewLeafFromChat'],
  treePreviewSnapshotRepository: ['storeTreePreviewSnapshot'],
  persistenceToolShared: ['assertWritableRuntimeTree', 'buildPersistenceToolHandlerResult', 'buildTreePreviewToolOutput'],
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const exports = exportsByModule[specifier.split('/').at(-1)];
    if (specifier.startsWith('@/') && exports) {
      const code = exports.map((key) => `export const ${key} = (...args) => globalThis.__previewMocks.${key}(...args);`).join('\n');
      return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { createPreviewAddToTreeHandler, previewAddToTreeToolDefinition } = await import('./index.js');

function prepare({ currentUserMessage = 'Add this to a tree: Rainwater harvesting collects runoff.', writable = true } = {}) {
  const calls = [];
  globalThis.__previewMocks = {
    assertWritableRuntimeTree: async (request) => {
      calls.push(['access', request]);
      if (!writable) throw new Error('Not writable');
    },
    previewLeafFromChat: async (request) => {
      calls.push(['preview', request]);
      return { treeName: 'Knowledge', defaultSaveMode: 'create_leaf' };
    },
    storeTreePreviewSnapshot: async (request) => { calls.push(['snapshot', request]); },
    buildTreePreviewToolOutput: (previewId, preview) => ({ previewId, preview }),
    buildPersistenceToolHandlerResult: (request) => request,
  };
  const handler = createPreviewAddToTreeHandler({
    includedTrees: [{ id: 7, name: 'Knowledge' }],
    principal: { userId: 'owner' },
    currentUserMessage,
  });
  return { calls, handler };
}

const directRequest = {
  toolName: 'search_tree_knowledge_7',
  originalQuestion: 'How does rainwater harvesting work?',
  broaderAnswer: 'Rainwater harvesting collects runoff.',
  contentSource: 'current_user_text',
};

test('direct text previews verbatim content and stores only a preview snapshot', async () => {
  const { calls, handler } = prepare();
  const result = await handler(directRequest);
  assert.deepEqual(calls.map(([name]) => name), ['access', 'preview', 'snapshot']);
  assert.equal(calls[1][1].broaderAnswer, directRequest.broaderAnswer);
  assert.equal(calls[2][1].previewId, result.toolOutput.previewId);
  assert.ok(result.toolOutput.previewId);
});

test('direct text absent from the current message is rejected before authorization or preview', async () => {
  const { calls, handler } = prepare();
  await assert.rejects(handler({ ...directRequest, broaderAnswer: 'A new fact from the model.' }), /current user message/);
  await assert.rejects(handler({ ...directRequest, broaderAnswer: '  ' }), /current user message/);
  await assert.rejects(handler({ ...directRequest, broaderAnswer: 'Add this to a tree: Rainwater harvesting collects runoff.' }), /current user message/);
  assert.deepEqual(calls, []);
});

test('an accepted prior broad answer remains previewable without appearing in the current message', async () => {
  const { calls, handler } = prepare({ currentUserMessage: 'Yes, save the answer.' });
  await handler({ ...directRequest, contentSource: 'prior_broad_answer' });
  assert.deepEqual(calls.map(([name]) => name), ['access', 'preview', 'snapshot']);
});

test('invalid source and nonwritable tree cannot create a preview snapshot', async () => {
  const { calls, handler } = prepare({ writable: false });
  await assert.rejects(handler({ ...directRequest, contentSource: 'other' }), /valid source/);
  await assert.rejects(handler({ ...directRequest, contentSource: undefined }), /valid source/);
  await assert.rejects(handler(directRequest), /Not writable/);
  assert.deepEqual(calls.map(([name]) => name), ['access']);
});

test('the published preview tool requires an explicit content source', () => {
  assert.ok(previewAddToTreeToolDefinition.parameters.required.includes('contentSource'));
  assert.deepEqual(previewAddToTreeToolDefinition.parameters.properties.contentSource.enum, ['current_user_text', 'prior_broad_answer']);
});