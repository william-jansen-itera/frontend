import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const exportsByModule = {
  treeMutationService: ['previewLeafFromChat', 'reviseLeafPreviewPath'],
  chatUploadRepository: ['getOwnedChatUpload'],
  treeCatalog: ['getAuditMetadata', 'assertTreeAccess'],
  agentToolResult: ['buildAgentToolResult', 'buildUntrustedContentMeta'],
  treePreviewSnapshotRepository: ['storeTreePreviewSnapshot', 'getTreePreviewSnapshot', 'replaceTreePreviewSnapshot'],
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
const { createReviseTreePreviewHandler } = await import('../reviseTreePreviewTool/index.js');
const { buildTreePreviewToolOutput: buildActualPreviewOutput } = await import('../persistenceToolShared.js');

function prepare({ currentUserMessage = 'Add this to a tree: Rainwater harvesting collects runoff.', writable = true, previewUploadId = null, currentUploadId = null, upload = null } = {}) {
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
    currentUploadId,
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
  assert.equal(calls[2][1].preview.saveKind, 'note');
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

test('completed upload preview uses the owned extracted text and placement evidence, not agent-supplied content', async () => {
  const { calls, handler } = prepare({ previewUploadId: 'owned-upload', upload: {
    status: 'succeeded', saveKind: 'note', extractedNoteText: 'Original\ntext.', note: 'Verified note.', caption: 'Filtered image caption.',
  } });
  await handler({ ...directRequest, broaderAnswer: 'Invented content.', contentSource: 'completed_upload_note', uploadId: 'owned-upload' });
  assert.deepEqual(calls.map(([name]) => name), ['upload', 'access', 'preview', 'snapshot']);
  assert.deepEqual(calls[0][1], { uploadId: 'owned-upload', ownerObjectId: 'owner' });
  assert.equal(calls[2][1].broaderAnswer, 'Verified note.');
  assert.equal(calls[2][1].placementCaption, 'Filtered image caption.');
  assert.equal(calls[3][1].preview.broaderAnswer, 'Original\ntext.');
  assert.equal(calls[3][1].preview.saveKind, 'note');
});

test('attachment preview freezes upload identity and placement evidence without replacing node notes', async () => {
  const { calls, handler } = prepare({ previewUploadId: 'owned-upload', upload: {
    status: 'succeeded', saveKind: 'attachment', fileName: 'image.png', byteSize: 4, sha256: 'hash',
    note: 'Placement Note: A lighthouse.', caption: 'Harbor at dusk.',
  } });
  await handler({ ...directRequest, contentSource: 'completed_upload_note', uploadId: 'owned-upload' });
  assert.equal(calls[3][1].preview.saveKind, 'attachment');
  assert.equal(calls[3][1].preview.uploadId, 'owned-upload');
  assert.equal(calls[3][1].preview.placementCaption, 'Harbor at dusk.');
  assert.equal(calls[2][1].broaderAnswer, 'Placement Note: A lighthouse.');
  assert.equal(calls[3][1].preview.placementNote, 'Placement Note: A lighthouse.');
  assert.equal(calls[3][1].preview.broaderAnswer, 'Placement Note: A lighthouse.');
});

test('attachment preview output leaves model note and caption text unchanged', () => {
  const output = buildActualPreviewOutput('preview-id', {
    saveKind: 'attachment', placementNote: 'Placement Note: A lighthouse.', placementCaption: 'Harbor at dusk.',
  });
  assert.equal(output.createLeafNotes, 'Placement Note: A lighthouse.\n\nHarbor at dusk.');
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

test('sparse attachment requires a human topic and does not invent saved notes', async () => {
  const upload = { status: 'succeeded', saveKind: 'attachment', fileName: 'photo.png', byteSize: 4, sha256: 'hash' };
  const automated = prepare({ previewUploadId: 'owned-upload', upload });
  await assert.rejects(automated.handler({ ...directRequest, contentSource: 'completed_upload_note', uploadId: 'owned-upload' }), /human-provided topic/);
  const human = prepare({ currentUploadId: 'owned-upload', currentUserMessage: 'Please save the harbor photo', upload });
  await human.handler({ ...directRequest, originalQuestion: 'harbor photo', contentSource: 'completed_upload_note', uploadId: 'owned-upload' });
  assert.equal(human.calls[2][1].broaderAnswer, 'harbor photo');
  assert.equal(human.calls[3][1].preview.placementNote, '');
  assert.equal(human.calls[3][1].preview.broaderAnswer, '');
});

test('path revision preserves the classified attachment payload', async () => {
  const { calls } = prepare();
  const frozen = {
    treeId: '7', saveKind: 'attachment', uploadId: 'owned-upload', fileName: 'photo.png',
    byteSize: 4, sha256: 'hash', placementNote: 'Lighthouse.', placementCaption: 'Harbor.', broaderAnswer: 'Lighthouse.',
  };
  globalThis.__previewMocks.getTreePreviewSnapshot = async () => frozen;
  globalThis.__previewMocks.reviseLeafPreviewPath = async () => ({ ...frozen, generatedLeafTitle: 'New photo',
    saveKind: 'note', uploadId: 'other-upload', placementCaption: 'Altered caption.' });
  globalThis.__previewMocks.replaceTreePreviewSnapshot = async (args) => { calls.push(['replace', args]); };
  await createReviseTreePreviewHandler({ includedTreeIds: new Set(['7']), principal: {}, includeDebug: false })({
    previewId: 'old', requestedPath: 'Knowledge > New photo',
  });
  const revised = calls.find(([name]) => name === 'replace')[1].preview;
  assert.equal(revised.saveKind, 'attachment');
  assert.equal(revised.uploadId, 'owned-upload');
  assert.equal(revised.placementCaption, 'Harbor.');
});