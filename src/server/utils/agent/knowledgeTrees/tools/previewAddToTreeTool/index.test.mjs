import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const exportsByModule = {
  treeMutationService: ['previewLeafFromChat'],
  chatUploadRepository: ['getOwnedChatUpload'],
  treeCatalog: ['getAuditMetadata'],
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

function prepare({ currentUserMessage = 'Add this to a tree: Rainwater harvesting collects runoff.', writable = true, previewUploadId = null, upload = null } = {}) {
  const calls = [];
  globalThis.__previewMocks = {
    getAuditMetadata: () => ({ updatedByObjectId: 'owner' }),
    getOwnedChatUpload: async (request) => { calls.push(['upload', request]); return upload; },
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
    previewUploadId,
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

test('completed upload preview uses the owned server note and caption, not agent-supplied content', async () => {
  const { calls, handler } = prepare({ previewUploadId: 'owned-upload', upload: { status: 'succeeded', note: 'Verified note.', caption: 'Filtered image caption.' } });
  await handler({ ...directRequest, broaderAnswer: 'Invented content.', contentSource: 'completed_upload_note', uploadId: 'owned-upload' });
  assert.deepEqual(calls.map(([name]) => name), ['upload', 'access', 'preview', 'snapshot']);
  assert.deepEqual(calls[0][1], { uploadId: 'owned-upload', ownerObjectId: 'owner' });
  assert.equal(calls[2][1].broaderAnswer, 'Verified note.');
  assert.equal(calls[2][1].placementCaption, 'Filtered image caption.');
});

test('completed upload preview rejects missing authorization and unfinished uploads', async () => {
  const unauthorized = prepare({ upload: { status: 'succeeded', note: 'Verified note.' } });
  await assert.rejects(unauthorized.handler({ ...directRequest, contentSource: 'completed_upload_note', uploadId: 'owned-upload' }), /authorized/);
  assert.deepEqual(unauthorized.calls, []);
  const unfinished = prepare({ previewUploadId: 'owned-upload', upload: { status: 'running' } });
  await assert.rejects(unfinished.handler({ ...directRequest, contentSource: 'completed_upload_note', uploadId: 'owned-upload' }), /not available/);
  assert.deepEqual(unfinished.calls.map(([name]) => name), ['upload']);
});

test('completed upload preview rejects a different owned upload ID', async () => {
  const { calls, handler } = prepare({ previewUploadId: 'current-upload', upload: { status: 'succeeded', note: 'Other note.' } });
  await assert.rejects(handler({ ...directRequest, contentSource: 'completed_upload_note', uploadId: 'other-upload' }), /authorized/);
  assert.deepEqual(calls, []);
});

test('completed upload preview cannot substitute user text or a prior answer', async () => {
  const { calls, handler } = prepare({ previewUploadId: 'owned-upload', upload: { status: 'succeeded', note: 'Verified note.' } });
  await assert.rejects(handler(directRequest), /Only the completed upload note/);
  await assert.rejects(handler({ ...directRequest, contentSource: 'prior_broad_answer' }), /Only the completed upload note/);
  assert.deepEqual(calls, []);
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
  assert.ok(previewAddToTreeToolDefinition.parameters.required.includes('uploadId'));
  assert.deepEqual(previewAddToTreeToolDefinition.parameters.properties.contentSource.enum, ['current_user_text', 'prior_broad_answer', 'completed_upload_note']);
});