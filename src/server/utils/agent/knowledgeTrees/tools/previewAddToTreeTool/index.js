import { randomUUID } from 'node:crypto';
import { previewLeafFromChat } from '@/server/utils/tree/treeMutationService';
import { storeTreePreviewSnapshot } from '@/server/utils/agent/knowledgeTrees/tools/treePreviewSnapshotRepository';
import {
  assertWritableRuntimeTree,
  buildPersistenceToolHandlerResult,
  buildTreePreviewToolOutput,
} from '@/server/utils/agent/knowledgeTrees/tools/persistenceToolShared';

export const previewAddToTreeToolDefinition = {
  type: 'function',
  name: 'preview_save_to_tree',
  description: 'Preview existing-note merge (default when offered) or separate new-note creation only after the user accepts a save offer in an already-delivered broad answer. Use that answer, not a newly generated or expanded answer; clean it before preview for either mode. A prior yes to broaden is not consent to preview saving. The server caches the preview for confirmation; output includes previewId and destinations only.',
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
        description: 'The user question that led to the broader answer. This value is stored in the cached preview snapshot and later used during confirm_save_to_tree.',
      },
      broaderAnswer: {
        type: 'string',
        description: 'The already-delivered broad answer whose save offer the user accepted, cleaned into saveable reference-note content without adding new facts. This is stored only in the preview snapshot.',
      },
    },
    required: ['toolName', 'originalQuestion', 'broaderAnswer'],
    additionalProperties: false,
  },
};

export function createPreviewAddToTreeHandler({ includedTrees, principal, includeDebug }) {
  return async ({ toolName, originalQuestion, broaderAnswer }) => {
    const match = String(toolName ?? '').trim().match(/_(\d+)$/);
    const resolvedTreeId = match ? match[1] : '';
    const targetTree = includedTrees.find((tree) => String(tree.id) === resolvedTreeId);

    if (!targetTree) {
      throw new Error('A valid writable tree tool context is required to save a broader answer.');
    }

    try {
      await assertWritableRuntimeTree({ treeId: resolvedTreeId, principal });
    } catch (error) {
      if (error?.message === 'Tree was not found for the active application instance') {
        throw new Error(`Please check if you have permission to edit the tree "${targetTree.name}".`, { cause: error });
      }
      throw error;
    }

    const selectionCalls = [];
    const preview = await previewLeafFromChat({
      treeInstanceId: Number.parseInt(resolvedTreeId, 10),
      originalQuestion,
      broaderAnswer,
      onModelCall: includeDebug ? (call) => selectionCalls.push(call) : undefined,
    });

    const previewId = randomUUID();
    await storeTreePreviewSnapshot({ previewId, preview, principal });

    return buildPersistenceToolHandlerResult({
      toolName: previewAddToTreeToolDefinition.name,
      toolResultType: 'tree_note_preview',
      toolOutput: buildTreePreviewToolOutput(previewId, preview),
      untrustedDataPaths: ['treeName', 'createPath', 'mergePath', 'defaultSavePath'],
      includeDebug,
      debug: { placementSelection: { modelCallCount: selectionCalls.length, calls: selectionCalls } },
    });
  };
}
