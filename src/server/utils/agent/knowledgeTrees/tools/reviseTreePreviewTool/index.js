import { randomUUID } from 'node:crypto';
import { reviseLeafPreviewPath } from '@/server/utils/tree/treeMutationService';
import {
  getTreePreviewSnapshot,
  replaceTreePreviewSnapshot,
} from '@/server/utils/agent/knowledgeTrees/tools/treePreviewSnapshotRepository';
import {
  assertWritableRuntimeTree,
  buildPersistenceToolHandlerResult,
  buildTreePreviewToolOutput,
} from '@/server/utils/agent/knowledgeTrees/tools/persistenceToolShared';

export const reviseTreePreviewToolDefinition = {
  type: 'function',
  name: 'revise_save_preview',
  description: 'Choose a different path for creating a new leaf, even when the original preview offered merging. The complete path must end in a new leaf title, not an existing note. Returns a new previewId; the old preview cannot be confirmed.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      previewId: {
        type: 'string',
        description: 'The exact previewId from the latest preview response.',
      },
      requestedPath: {
        type: 'string',
        description: 'Complete path after the tree name, ending in a new leaf title, with titles separated by >.',
      },
    },
    required: ['previewId', 'requestedPath'],
    additionalProperties: false,
  },
};

export function createReviseTreePreviewHandler({ includedTreeIds, principal, includeDebug }) {
  return async ({ previewId, requestedPath }) => {
    const preview = await getTreePreviewSnapshot({ previewId, principal });
    const treeId = String(preview.treeId ?? '').trim();

    if (!includedTreeIds.has(treeId)) {
      throw new Error('The preview tree is not available in the current request. Preview the save again.');
    }

    await assertWritableRuntimeTree({ treeId, principal });
    const revisedPlacement = await reviseLeafPreviewPath({
      treeInstanceId: Number.parseInt(treeId, 10),
      preview,
      requestedPath,
    });
    const revisedPreview = { ...revisedPlacement,
      saveKind: preview.saveKind, uploadId: preview.uploadId, fileName: preview.fileName,
      byteSize: preview.byteSize, sha256: preview.sha256, extractedNoteText: preview.extractedNoteText,
      placementNote: preview.placementNote, placementCaption: preview.placementCaption,
      broaderAnswer: preview.broaderAnswer,
    };
    const revisedPreviewId = randomUUID();
    await replaceTreePreviewSnapshot({ previousPreviewId: previewId, previewId: revisedPreviewId, preview: revisedPreview, principal });

    return buildPersistenceToolHandlerResult({
      toolName: reviseTreePreviewToolDefinition.name,
      toolResultType: 'tree_note_preview',
      toolOutput: buildTreePreviewToolOutput(revisedPreviewId, revisedPreview),
      untrustedDataPaths: ['treeName', 'createPath', 'mergePath', 'defaultSavePath', 'fileName', 'createLeafNotes'],
      includeDebug,
    });
  };
}