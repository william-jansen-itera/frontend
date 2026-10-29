import { randomUUID } from 'node:crypto';
import { reviseLeafPreviewPath } from '@/server/utils/tree/treeMutationService';
import {
  getTreePreviewSnapshot,
  replaceTreePreviewSnapshot,
} from '@/server/utils/agent/knowledgeTrees/tools/treePreviewSnapshotRepository';
import {
  assertWritableRuntimeTree,
  buildPersistenceToolHandlerResult,
} from '@/server/utils/agent/knowledgeTrees/tools/persistenceToolShared';

export const reviseTreePreviewToolDefinition = {
  type: 'function',
  name: 'revise_tree_preview',
  description: 'Update the suggested placement after the user requests a different path. Use the latest previewId and the complete path from the first tree node through the note title, separated by >. This returns a new previewId; the previous preview can no longer be confirmed.',
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
        description: 'Complete path after the tree name, including the final note title, with titles separated by >.',
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
    const revisedPreview = await reviseLeafPreviewPath({
      treeInstanceId: Number.parseInt(treeId, 10),
      preview,
      requestedPath,
    });
    const revisedPreviewId = randomUUID();
    await replaceTreePreviewSnapshot({ previousPreviewId: previewId, previewId: revisedPreviewId, preview: revisedPreview, principal });

    return buildPersistenceToolHandlerResult({
      toolName: reviseTreePreviewToolDefinition.name,
      toolResultType: 'tree_note_preview',
      toolOutput: { previewId: revisedPreviewId, ...revisedPreview, toolName: reviseTreePreviewToolDefinition.name },
      includeDebug,
    });
  };
}