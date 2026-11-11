import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const exportsByModule = {
  treeMutationService: ['createLeafNodeFromChat', 'createTreeNodeAttachment', 'mergeLeafNodeFromChat', 'normalizeUpdatedByMetadata'],
  chatUploadRepository: ['getOwnedChatUpload'],
  stagingBlob: ['readVerifiedStagingFile'],
  treeCatalog: ['getAuditMetadata'],
  treePreviewSnapshotRepository: ['consumeTreePreviewSnapshot', 'getTreePreviewSnapshot'],
  persistenceToolShared: ['assertWritableRuntimeTree', 'buildPersistenceToolHandlerResult'],
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

function prepare({ saveKind = 'note', mergeTarget = null, expired = false } = {}) {
  const calls = [];
  const preview = {
    treeId: '7', treeName: 'Knowledge', originalQuestion: 'Where does this belong?',
    broaderAnswer: 'Original\ntext.', saveKind, uploadId: 'upload', fileName: 'file.pdf',
    byteSize: 4, sha256: 'hash', extractedNoteText: saveKind === 'note' ? 'Original\ntext.' : undefined,
    placementNote: 'Placement facts.', placementCaption: 'Filtered caption.',
    createPath: 'Knowledge > New leaf', mergeTarget,
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
  };
  return { calls, preview, handler: createConfirmAddToTreeHandler({ includedTreeIds: new Set(['7']), principal: {}, includeDebug: false }) };
}

test('confirmed short upload merges the frozen extracted text', async () => {
  const { calls, handler, preview } = prepare({ mergeTarget: { nodeId: '3', breadcrumb: 'Knowledge > Existing' } });
  const result = await handler({ previewId: 'id', saveMode: 'merge_existing' });
  assert.equal(calls.find((call) => Array.isArray(call) && call[0] === 'merge')[1].preview.broaderAnswer, 'Original\ntext.');
  assert.equal(preview.placementNote, 'Placement facts.');
  assert.equal(result.toolResultType, 'tree_note_updated');
});

test('new attachment leaf keeps the model text and caption with the verified original file', async () => {
  const { calls, handler } = prepare({ saveKind: 'attachment' });
  const result = await handler({ previewId: 'id', saveMode: 'create_leaf' });
  assert.deepEqual(calls.slice(0, 3), ['lookup', 'verify', 'consume']);
  const created = calls.find((call) => Array.isArray(call) && call[0] === 'create')[1];
  assert.equal(created.broaderAnswer, 'Placement facts.\n\nFiltered caption.');
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