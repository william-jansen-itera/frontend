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

function prepare({ currentUserMessage = 'Add this to a tree: Rainwater harvesting collects runoff.', writable = true, previewUploadId = null, currentUploadId = null, pendingUploadId = null, upload = null } = {}) {
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
    pendingUploadId,
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
  assert.equal(calls[3][1].preview.incomingNotes,
    'Document extraction (verbatim):\nOriginal\ntext.\n\nProcessed placement note:\nVerified note.\n\nGenerated image caption:\nFiltered image caption.');
  assert.equal(calls[3][1].preview.broaderAnswer, calls[3][1].preview.incomingNotes);
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
  assert.equal(calls[2][1].uploadContext.fileName, 'image.png');
  assert.ok(!calls[3][1].preview.incomingNotes.includes('image.png'));
});

test('attachment preview output uses only the frozen incoming notes', () => {
  const output = buildActualPreviewOutput('preview-id', {
    saveKind: 'attachment', uploadId: 'owned-upload', incomingNotes: 'Generated image caption:\nHarbor at dusk.',
    placementNote: 'Placement Note: A lighthouse.', placementCaption: 'Harbor at dusk.',
  });
  assert.equal(output.createLeafNotes, output.incomingNotes);
});

test('completed upload freezes verified human context separately from generated image evidence', async () => {
  const { calls, handler } = prepare({ pendingUploadId: 'owned-upload', currentUserMessage: 'It is a bass.', upload: {
    status: 'succeeded', saveKind: 'attachment', originalHumanMessage: 'Please save this fishing photo.',
    note: '', caption: 'A fish in a stream.', fileName: 'sea-bass.jpg',
  } });
  await handler({ ...directRequest, contentSource: 'completed_upload_note', uploadId: 'owned-upload',
    userDescription: 'fishing photo', userClarification: 'bass' });
  const placement = calls[2][1];
  assert.deepEqual(placement.uploadContext, {
    userDescription: 'fishing photo', userClarification: 'bass', placementNote: '', placementCaption: 'A fish in a stream.', fileName: 'sea-bass.jpg',
  });
  const incomingNotes = calls[3][1].preview.incomingNotes;
  assert.equal(incomingNotes, 'User description:\nfishing photo\n\nUser clarification:\nbass\n\nGenerated image caption:\nA fish in a stream.');
  assert.ok(!incomingNotes.includes('sea-bass.jpg'));
  assert.equal(calls[3][1].preview.placementNote, '');
  assert.equal(calls[3][1].preview.userClarification, 'bass');
});

test('upload rejects invented human excerpts and treats opt-outs as no new detail', async () => {
  const upload = { status: 'succeeded', saveKind: 'attachment', originalHumanMessage: 'A fish', caption: 'Fish in water' };
  const { handler, calls } = prepare({ pendingUploadId: 'owned-upload', currentUserMessage: 'use what is available', upload });
  const request = { ...directRequest, contentSource: 'completed_upload_note', uploadId: 'owned-upload' };
  await assert.rejects(handler({ ...request, userDescription: 'trout' }), /original human message/);
  await assert.rejects(handler({ ...request, userClarification: 'invented species' }), /current human reply/);
  await handler({ ...request, userClarification: 'use what is available' });
  assert.equal(calls.at(-1)[1].preview.userClarification, '');
  assert.equal(calls.at(-1)[1].preview.userDescription, '');
  for (const answer of ['yes', 'no', 'ja', 'nej']) {
    const reply = prepare({ pendingUploadId: 'owned-upload', currentUserMessage: answer, upload });
    await reply.handler({ ...request, userClarification: answer });
    assert.equal(reply.calls.at(-1)[1].preview.userClarification, '');
    assert.equal(reply.calls.at(-1)[1].preview.incomingNotes, 'Generated image caption:\nFish in water');
  }
});

test('preview rejects a labeled note that exceeds storage capacity without truncating extraction', async () => {
  const { calls, handler } = prepare({ previewUploadId: 'owned-upload', upload: {
    status: 'succeeded', saveKind: 'note', extractedNoteText: 'x'.repeat(3990), note: 'Short note',
  } });
  await assert.rejects(handler({ ...directRequest, contentSource: 'completed_upload_note', uploadId: 'owned-upload' }), /exceed 4000/);
  assert.deepEqual(calls.map(([name]) => name), ['upload']);
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
  const human = prepare({ pendingUploadId: 'owned-upload', currentUserMessage: 'Please save the harbor photo', upload });
  await human.handler({ ...directRequest, originalQuestion: 'harbor photo', contentSource: 'completed_upload_note', uploadId: 'owned-upload', userClarification: 'harbor photo' });
  assert.equal(human.calls[2][1].broaderAnswer, 'harbor photo');
  assert.equal(human.calls[3][1].preview.placementNote, '');
  assert.equal(human.calls[3][1].preview.userClarification, 'harbor photo');
});

test('path revision preserves the classified attachment payload', async () => {
  const { calls } = prepare();
  const frozen = {
    treeId: '7', saveKind: 'attachment', uploadId: 'owned-upload', fileName: 'photo.png',
    byteSize: 4, sha256: 'hash', placementNote: 'Lighthouse.', placementCaption: 'Harbor.', broaderAnswer: 'Lighthouse.',
    userDescription: 'Harbor photo', userClarification: 'At dusk', incomingNotes: 'User description:\nHarbor photo',
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
  assert.equal(revised.userDescription, 'Harbor photo');
  assert.equal(revised.userClarification, 'At dusk');
  assert.equal(revised.incomingNotes, 'User description:\nHarbor photo');
});