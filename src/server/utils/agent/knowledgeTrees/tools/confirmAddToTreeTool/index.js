import { createLeafNodeFromChat } from '@/server/utils/tree/treeMutationService';
import { consumeTreePreviewSnapshot } from '@/server/utils/agent/knowledgeTrees/tools/treePreviewSnapshotRepository';
import {
  assertWritableRuntimeTree,
  buildPersistenceToolHandlerResult,
} from '@/server/utils/agent/knowledgeTrees/tools/persistenceToolShared';

export const confirmAddToTreeToolDefinition = {
  type: 'function',
  name: 'confirm_add_to_tree',
  description: 'Create a new tree note after the user explicitly confirms the previewed save plan. The server uses the cached preview snapshot as the source of truth; if previewId is stale or missing, preview the save again. This is the only confirmation step after the preview. The output includes noteLink for the final reply.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      previewId: {
        type: 'string',
        description: 'The exact previewId returned by preview_add_to_tree. Pass only this id so the server can load the cached preview snapshot.',
      },
    },
    required: ['previewId'],
    additionalProperties: false,
  },
};

export function createConfirmAddToTreeHandler({ includedTreeIds, principal, includeDebug }) {
  return async ({ previewId }) => {
    if (!String(previewId ?? '').trim()) {
      throw new Error('A previewId from preview_add_to_tree is required to confirm saving the broader answer.');
    }

    const preview = await consumeTreePreviewSnapshot({ previewId, principal });
    const resolvedTreeId = String(preview?.treeId ?? '').trim();

    if (!includedTreeIds.has(resolvedTreeId)) {
      throw new Error('A valid writable tree id is required to save a broader answer.');
    }

    const writableTree = await assertWritableRuntimeTree({ treeId: resolvedTreeId, principal });
    const createdLeaf = await createLeafNodeFromChat({
      treeInstanceId: Number.parseInt(resolvedTreeId, 10),
      principal,
      toolName: confirmAddToTreeToolDefinition.name,
      originalQuestion: preview.originalQuestion,
      broaderAnswer: preview.broaderAnswer,
      placementMode: preview.placementMode,
      selectedAnchorNodeId: preview.selectedAnchorNodeId,
      selectedAnchorBreadcrumb: preview.selectedAnchorBreadcrumb,
      generatedPathTitles: preview.generatedPathTitles,
      plannedLeafParentBreadcrumb: preview.plannedLeafParentBreadcrumb,
      generatedLeafTitle: preview.generatedLeafTitle,
    });
    const noteSearchParams = new URLSearchParams({
      treeId: String(createdLeaf.treeId),
      nodeId: String(createdLeaf.createdNodeId),
      visibility: writableTree.isPrivate ? 'private' : 'public',
    });

    const toolOutput = {
      ...createdLeaf,
      noteLink: `[View note](/notes?${noteSearchParams.toString()})`,
    };
    delete toolOutput.flatData;

    return buildPersistenceToolHandlerResult({
      toolName: confirmAddToTreeToolDefinition.name,
      toolResultType: 'tree_note_created',
      toolOutput,
      includeDebug,
    });
  };
}