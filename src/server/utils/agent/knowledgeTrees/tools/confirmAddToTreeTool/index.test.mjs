import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const exportsByModule = {
  treeMutationService: ['createLeafNodeFromChat', 'createTreeNodeAttachment', 'mergeLeafNodeFromChat', 'normalizeUpdatedByMetadata'],
  chatUploadRepository: ['getOwnedChatUpload'],
  stagingBlob: ['readVerifiedStagingFile'],
  treeCatalog: ['getAuditMetadata', 'assertTreeAccess'],
  agentToolResult: ['buildAgentToolResult', 'buildUntrustedContentMeta'],
  treePreviewSnapshotRepository: ['consumeTreePreviewSnapshot', 'getTreePreviewSnapshot'],
  persistenceToolShared: ['assertWritableRuntimeTree', 'buildPersistenceToolHandlerResult', 'buildTreePreviewToolOutput'],
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const exports = exportsByModule[specifier.split('/').at(-1)];
    if (specifier.startsWith('@/') && exports) {
      const code = exports.map((key) => `export const ${key} = (...args) => globalThis.__confirmMocks.${key}(...args);`).join('\n');
      return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { createConfirmAddToTreeHandler } = await import('./index.js');
const { buildTreePreviewToolOutput } = await import('../persistenceToolShared.js');

function prepare({ saveKind = 'note', mergeTarget = null, expired = false } = {}) {
  const calls = [];
  const preview = {
    treeId: '7', treeName: 'Knowledge', originalQuestion: 'Where does this belong?',
    broaderAnswer: saveKind === 'note' ? 'Document extraction (verbatim):\nOriginal\ntext.' : 'Placement facts.',
    saveKind, uploadId: 'upload', fileName: 'file.pdf',
    byteSize: 4, sha256: 'hash', extractedNoteText: saveKind === 'note' ? 'Original\ntext.' : undefined,
    placementNote: 'Placement facts.', placementCaption: 'Filtered caption.',
    incomingNotes: saveKind === 'note' ? 'Document extraction (verbatim):\nOriginal\ntext.'
      : 'Processed placement note:\nPlacement facts.\n\nGenerated image caption:\nFiltered caption.',
    createPath: 'Knowledge > New leaf', mergeTarget,
    defaultSaveMode: mergeTarget ? 'merge_existing' : 'create_leaf',
  };
  const upload = {
    id: 'upload', status: 'succeeded', saveKind, fileName: 'file.pdf', byteSize: 4,
    sha256: 'hash', extractedNoteText: preview.extractedNoteText,
  };
  const file = { name: 'file.pdf', size: 4, arrayBuffer: async () => Buffer.from('file') };
  globalThis.__confirmMocks = {
    getTreePreviewSnapshot: async () => preview,
    consumeTreePreviewSnapshot: async () => { calls.push('consume'); return preview; },
    getAuditMetadata: () => ({ updatedByObjectId: 'owner' }),
    getOwnedChatUpload: async () => { calls.push('lookup'); return expired ? null : upload; },
    readVerifiedStagingFile: async () => { calls.push('verify'); return file; },
    assertWritableRuntimeTree: async () => ({ isPrivate: false }),
    normalizeUpdatedByMetadata: () => ({ updatedByObjectId: 'owner' }),
    mergeLeafNodeFromChat: async (args) => { calls.push(['merge', args]); return { treeId: '7', updatedNodeId: '3' }; },
    createLeafNodeFromChat: async (args) => { calls.push(['create', args]); return { treeId: '7', createdNodeId: '4' }; },
    createTreeNodeAttachment: async (args) => { calls.push(['attach', args]); return { notes: 'Unchanged' }; },
    buildPersistenceToolHandlerResult: (args) => args,
    buildTreePreviewToolOutput,
  };
  return { calls, preview, upload, handler: createConfirmAddToTreeHandler({ includedTreeIds: new Set(['7']), principal: {}, includeDebug: false }) };
}

test('confirmed short upload merges the frozen labeled incoming notes', async () => {
  const { calls, handler, preview } = prepare({ mergeTarget: { nodeId: '3', breadcrumb: 'Knowledge > Existing' } });
  const result = await handler({ previewId: 'id', saveMode: 'merge_existing' });
  assert.equal(calls.find((call) => Array.isArray(call) && call[0] === 'merge')[1].preview.incomingNotes, preview.incomingNotes);
  assert.equal(preview.broaderAnswer, preview.incomingNotes);
  assert.equal(preview.placementNote, 'Placement facts.');
  assert.equal(result.toolResultType, 'tree_note_updated');
});

test('new attachment leaf saves the frozen incoming notes with the verified original file', async () => {
  const { calls, preview, handler } = prepare({ saveKind: 'attachment' });
  const result = await handler({ previewId: 'id', saveMode: 'create_leaf' });
  assert.deepEqual(calls.slice(0, 3), ['lookup', 'verify', 'consume']);
  const created = calls.find((call) => Array.isArray(call) && call[0] === 'create')[1];
  assert.equal(created.broaderAnswer, preview.incomingNotes);
  assert.equal(created.attachmentFile.name, 'file.pdf');
  assert.equal(result.toolResultType, 'tree_attachment_saved');
});

test('existing attachment leaf receives only the file, preserving its notes', async () => {
  const target = { nodeId: '3', breadcrumb: 'Knowledge > Existing', notesFingerprint: 'fingerprint' };
  const { calls, handler } = prepare({ saveKind: 'attachment', mergeTarget: target });
  const result = await handler({ previewId: 'id', saveMode: 'merge_existing' });
  assert.equal(calls.find((call) => Array.isArray(call) && call[0] === 'attach')[1].expectedTarget, target);
  assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === 'merge'));
  assert.equal(result.toolResultType, 'tree_attachment_saved');
});

test('unoffered merge is rejected before upload lookup, preview consumption, or saving', async () => {
  for (const saveKind of ['note', 'attachment']) {
    const { calls, handler } = prepare({ saveKind });
    await assert.rejects(handler({ previewId: 'id', saveMode: 'merge_existing' }), /save mode was not offered/);
    assert.deepEqual(calls, []);
  }
});

test('unoffered creation returns exact merge recovery arguments without consuming or saving', async () => {
  for (const saveKind of ['note', 'attachment']) {
    const { calls, preview, handler } = prepare({ saveKind,
      mergeTarget: { nodeId: '3', breadcrumb: 'Knowledge > Existing' } });
    preview.createPath = null;
    if (saveKind === 'note') {
      delete preview.uploadId;
      preview.incomingNotes = null;
    }
    await assert.rejects(handler({ previewId: 'id', saveMode: 'create_leaf' }), (error) => {
      assert.match(error.message, /save mode was not offered/);
      assert.match(error.message, /preview was not consumed/);
      assert.match(error.message, /"availableSaveModes":\["merge_existing"\]/);
      assert.match(error.message, /"defaultConfirmArguments":\{"previewId":"id","saveMode":"merge_existing"\}/);
      assert.match(error.message, /If the human approved the default, retry confirm_save_to_tree/);
      assert.match(error.message, /wait for approval of that new preview/);
      return true;
    });
    assert.deepEqual(calls, []);
    const result = await handler({ previewId: 'id', saveMode: 'merge_existing' });
    assert.equal(result.toolResultType, saveKind === 'note' ? 'tree_note_updated' : 'tree_attachment_saved');
    assert.equal(calls.filter((call) => call === 'consume').length, 1);
    assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === 'create'));
  }
});

test('new upload note and attachment leaf save the same frozen labeled notes shown at preview', async () => {
  for (const saveKind of ['note', 'attachment']) {
    const { calls, preview, upload, handler } = prepare({ saveKind });
    preview.incomingNotes = 'User description:\nA river\n\nProcessed placement note:\nFreshwater fishing';
    preview.userDescription = 'A river';
    upload.originalHumanMessage = 'A river';
    const created = await handler({ previewId: 'id', saveMode: 'create_leaf' });
    assert.equal(calls.find((call) => Array.isArray(call) && call[0] === 'create')[1].broaderAnswer, preview.incomingNotes);
    assert.equal(created.toolResultType, saveKind === 'note' ? 'tree_note_created' : 'tree_attachment_saved');
  }
});

test('existing attachment leaf leaves notes unchanged even with frozen incoming notes', async () => {
  const { calls, preview, handler } = prepare({ saveKind: 'attachment', mergeTarget: {
    nodeId: '3', breadcrumb: 'Knowledge > Existing', notesFingerprint: 'fingerprint',
  } });
  preview.incomingNotes = 'User description:\nA river';
  await handler({ previewId: 'id', saveMode: 'merge_existing' });
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === 'attach'));
  assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === 'merge'));
});

test('expired upload fails before consuming the preview or writing', async () => {
  const { calls, handler } = prepare({ saveKind: 'attachment', expired: true });
  await assert.rejects(handler({ previewId: 'id', saveMode: 'create_leaf' }), /changed or expired/);
  assert.deepEqual(calls, ['lookup']);
});

test('unclassified previews are rejected without consuming or writing', async () => {
  const { calls, handler, preview } = prepare();
  delete preview.saveKind;
  await assert.rejects(handler({ previewId: 'id', saveMode: 'create_leaf' }), /no classified save action/);
  assert.deepEqual(calls, []);
});

test('upload previews without frozen incoming notes are rejected before consuming or writing', async () => {
  for (const saveKind of ['note', 'attachment']) {
    const { calls, preview, handler } = prepare({ saveKind });
    delete preview.incomingNotes;
    await assert.rejects(handler({ previewId: 'id', saveMode: 'create_leaf' }), /valid frozen incoming notes/);
    assert.deepEqual(calls, []);
  }
});