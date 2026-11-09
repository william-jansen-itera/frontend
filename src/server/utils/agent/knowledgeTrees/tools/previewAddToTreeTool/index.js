import { randomUUID } from 'node:crypto';
import { previewLeafFromChat } from '@/server/utils/tree/treeMutationService';
import { getOwnedChatUpload } from '@/server/utils/agent/knowledgeTrees/chatUploadRepository';
import { getAuditMetadata } from '@/server/utils/tree/treeCatalog';
import { storeTreePreviewSnapshot } from '@/server/utils/agent/knowledgeTrees/tools/treePreviewSnapshotRepository';
import {
  assertWritableRuntimeTree,
  buildPersistenceToolHandlerResult,
  buildTreePreviewToolOutput,
} from '@/server/utils/agent/knowledgeTrees/tools/persistenceToolShared';

export const previewAddToTreeToolDefinition = {
  type: 'function',
  name: 'preview_save_to_tree',
  description: 'Preview existing-note merge (default when offered) or separate new-note creation for current user text, an accepted prior broad answer, or a completed upload note when the server authorizes its preview. Never invent or expand saved content. The server caches the preview for separate confirmation; output includes previewId and destinations only.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      toolName: {
        type: 'string',
        description: 'The specific dynamic search_tree_* tool that identifies the target tree for the note. Do not substitute a tree name or any other label.',
      },
      originalQuestion: {
        type: 'string',
        description: 'For current_user_text or completed_upload_note, a short topic question for placing the text; for prior_broad_answer, the question that led to that answer. Stored in the cached preview snapshot for confirmation.',
      },
      broaderAnswer: {
        type: 'string',
        description: 'For current_user_text, a verbatim factual excerpt of the current user message excluding the save request. For prior_broad_answer, the already-delivered answer cleaned without adding facts. For completed_upload_note, use an empty string; the server supplies the note.',
      },
      contentSource: {
        type: 'string',
        enum: ['current_user_text', 'prior_broad_answer', 'completed_upload_note'],
        description: 'Whether the text comes from the current user message, an accepted broad answer, or a server-authorized completed upload note.',
      },
      uploadId: {
        type: 'string',
        description: 'For completed_upload_note, the upload ID in the automated completion message; otherwise use an empty string.',
      },
    },
    required: ['toolName', 'originalQuestion', 'broaderAnswer', 'contentSource', 'uploadId'],
    additionalProperties: false,
  },
};

export function createPreviewAddToTreeHandler({ includedTrees, principal, includeDebug, currentUserMessage, previewUploadId = null }) {
  return async ({ toolName, originalQuestion, broaderAnswer, contentSource, uploadId }) => {
    if (previewUploadId && contentSource !== 'completed_upload_note') {
      throw new Error('Only the completed upload note can be previewed in this turn.');
    }
    if (contentSource !== 'completed_upload_note' && uploadId) {
      throw new Error('An upload ID is only valid for a completed upload preview.');
    }
    let noteText = broaderAnswer;
    if (contentSource === 'current_user_text') {
      const content = String(broaderAnswer ?? '').trim();
      const message = String(currentUserMessage ?? '').trim();
      if (!content || content === message || !message.includes(content)) {
        throw new Error('The note text must be taken from the current user message. Provide the text to save and preview again.');
      }
    } else if (contentSource === 'completed_upload_note') {
      const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;
      if (!previewUploadId || uploadId !== previewUploadId || !ownerObjectId) {
        throw new Error('A completed upload must be authorized for this preview.');
      }
      const upload = await getOwnedChatUpload({ uploadId, ownerObjectId });
      if (upload?.status !== 'succeeded' || !String(upload.note ?? '').trim()) {
        throw new Error('The completed upload note is not available for preview.');
      }
      noteText = String(upload.note).trim();
    } else if (contentSource !== 'prior_broad_answer') {
      throw new Error('A valid source for the note text is required.');
    }
    const match = String(toolName ?? '').trim().match(/_(\d+)$/);
    const resolvedTreeId = match ? match[1] : '';
    const targetTree = includedTrees.find((tree) => String(tree.id) === resolvedTreeId);

    if (!targetTree) {
      throw new Error('A valid writable tree tool context is required to preview saving the note.');
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
      broaderAnswer: noteText,
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
