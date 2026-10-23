import { randomUUID } from 'node:crypto';
import { previewLeafFromChat } from '@/server/utils/tree/treeMutationService';
import { storeTreePreviewSnapshot } from '@/server/utils/agent/knowledgeTrees/tools/treePreviewSnapshotRepository';
import {
  assertWritableRuntimeTree,
  buildPersistenceToolHandlerResult,
} from '@/server/utils/agent/knowledgeTrees/tools/persistenceToolShared';

export const previewAddToTreeToolDefinition = {
  type: 'function',
  name: 'preview_add_to_tree',
  description: 'Preview where a broader answer would be saved in a writable tree. Use only after the prior user-facing answer visibly offered to save it and the user explicitly accepted that offer; isPersistenceOffer=true alone is not permission. Call it directly once the user confirms. The output includes previewId, and the server caches the preview for a later confirm_add_to_tree call.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      toolName: {
        type: 'string',
        description: 'The specific dynamic search_tree_* tool that identifies the target tree for the new note. Do not substitute a tree name or any other label.',
      },
      originalQuestion: {
        type: 'string',
        description: 'The user question that led to the broader answer. This value is stored in the cached preview snapshot and later used during confirm_add_to_tree.',
      },
      broaderAnswer: {
        type: 'string',
        description: 'The broader answer cleaned and normalized into saveable tree-note content for the previewed note, while preserving detail needed for placement and note generation. This value is stored in the cached preview snapshot and later used during confirm_add_to_tree.',
      },
    },
    required: ['toolName', 'originalQuestion', 'broaderAnswer'],
    additionalProperties: false,
  },
};

export function createPreviewAddToTreeHandler({ includedTreeIds, principal, includeDebug }) {
  return async ({ toolName, originalQuestion, broaderAnswer }) => {
    const match = String(toolName ?? '').trim().match(/_(\d+)$/);
    const resolvedTreeId = match ? match[1] : '';

    if (!resolvedTreeId || !includedTreeIds.has(resolvedTreeId)) {
      throw new Error('A valid writable tree tool context is required to save a broader answer.');
    }

    await assertWritableRuntimeTree({ treeId: resolvedTreeId, principal });

    const preview = await previewLeafFromChat({
      treeInstanceId: Number.parseInt(resolvedTreeId, 10),
      originalQuestion,
      broaderAnswer,
    });

    const previewId = randomUUID();
    await storeTreePreviewSnapshot({ previewId, preview, principal });

    return buildPersistenceToolHandlerResult({
      toolName: previewAddToTreeToolDefinition.name,
      toolResultType: 'tree_note_preview',
      toolOutput: { previewId, ...preview, toolName: previewAddToTreeToolDefinition.name },
      includeDebug,
    });
  };
}