import { createLeafNodeFromChat, createTreeNodeAttachment, mergeLeafNodeFromChat, normalizeUpdatedByMetadata } from '@/server/utils/tree/treeMutationService';
import { getOwnedChatUpload } from '@/server/utils/agent/knowledgeTrees/chatUploadRepository';
import { readVerifiedStagingFile } from '@/server/utils/agent/knowledgeTrees/stagingBlob';
import { getAuditMetadata } from '@/server/utils/tree/treeCatalog';
import { consumeTreePreviewSnapshot, getTreePreviewSnapshot } from '@/server/utils/agent/knowledgeTrees/tools/treePreviewSnapshotRepository';
import {
  assertWritableRuntimeTree,
  buildPersistenceToolHandlerResult,
} from '@/server/utils/agent/knowledgeTrees/tools/persistenceToolShared';

export const confirmAddToTreeToolDefinition = {
  type: 'function',
  name: 'confirm_save_to_tree',
  description: 'Save only after the user approves the preview shown in the immediately preceding assistant reply with its Preview ID marker. A yes to a broad answer\'s save offer requires preview_save_to_tree first; it does not authorize confirmation. Choose the offered default mode for an unqualified yes (merge if offered), or create_leaf only if it was offered and the user explicitly requests a separate note. Use only the latest previewId, including a revised previewId when the path was changed. Failures after confirmation require a new preview.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      previewId: {
        type: 'string',
        description: 'The exact latest previewId returned by preview_save_to_tree or revise_save_preview. Pass only this id so the server can load the cached preview snapshot.',
      },
      saveMode: {
        type: 'string',
        enum: ['merge_existing', 'create_leaf'],
        description: 'The approved mode: use defaultSaveMode for an unqualified yes; choose create_leaf instead of an offered merge only when create_leaf was offered and the user explicitly requests a separate note.',
      },
    },
    required: ['previewId', 'saveMode'],
    additionalProperties: false,
  },
};

export function createConfirmAddToTreeHandler({ includedTreeIds, principal, includeDebug }) {
  return async ({ previewId, saveMode }) => {
    if (!String(previewId ?? '').trim()) {
      throw new Error('A previewId from the latest preview is required to confirm saving the broader answer.');
    }

    const offeredPreview = await getTreePreviewSnapshot({ previewId, principal });
    if (!['note', 'attachment'].includes(offeredPreview.saveKind) ||
        (offeredPreview.saveKind === 'attachment' && !offeredPreview.uploadId)) {
      throw new Error('The preview has no classified save action. Request a new preview.');
    }
    const createAvailable = Boolean(offeredPreview.createPath) &&
      offeredPreview.createPath.toLowerCase() !== offeredPreview.mergeTarget?.breadcrumb?.toLowerCase();
    if ((saveMode !== 'merge_existing' || !offeredPreview.mergeTarget) &&
        (saveMode !== 'create_leaf' || !createAvailable)) {
      throw new Error('That save mode was not offered for this preview. Request a new preview.');
    }
    let attachmentFile = null;
    if (offeredPreview.uploadId) {
      const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;
      const upload = ownerObjectId && await getOwnedChatUpload({ uploadId: offeredPreview.uploadId, ownerObjectId });
      if (!upload || upload.status !== 'succeeded' || upload.saveKind !== offeredPreview.saveKind ||
          upload.fileName !== offeredPreview.fileName || upload.byteSize !== offeredPreview.byteSize ||
          upload.sha256 !== offeredPreview.sha256 ||
          (upload.saveKind === 'note' && upload.extractedNoteText !== offeredPreview.extractedNoteText)) {
        throw new Error('The owned upload has changed or expired. Preview again.');
      }
      if (upload.saveKind === 'attachment') {
        attachmentFile = await readVerifiedStagingFile({ upload, ownerObjectId });
      }
    }
    const preview = await consumeTreePreviewSnapshot({ previewId, principal });
    const resolvedTreeId = String(preview?.treeId ?? '').trim();

    if (!includedTreeIds.has(resolvedTreeId)) {
      throw new Error('A valid writable tree id is required to save a broader answer.');
    }

    const writableTree = await assertWritableRuntimeTree({ treeId: resolvedTreeId, principal });
    const savedLeaf = attachmentFile && saveMode === 'merge_existing'
      ? {
        treeId: resolvedTreeId,
        updatedNodeId: preview.mergeTarget.nodeId,
        details: await createTreeNodeAttachment({
          treeInstanceId: Number.parseInt(resolvedTreeId, 10), nodeId: preview.mergeTarget.nodeId,
          files: [attachmentFile], updatedBy: normalizeUpdatedByMetadata(principal),
          expectedTarget: preview.mergeTarget,
        }),
      }
      : saveMode === 'merge_existing'
      ? await mergeLeafNodeFromChat({
        treeInstanceId: Number.parseInt(resolvedTreeId, 10),
        principal,
        toolName: confirmAddToTreeToolDefinition.name,
        preview,
      })
      : await createLeafNodeFromChat({
      treeInstanceId: Number.parseInt(resolvedTreeId, 10),
      principal,
      toolName: confirmAddToTreeToolDefinition.name,
      originalQuestion: preview.originalQuestion,
      broaderAnswer: attachmentFile
        ? [preview.placementNote && `Placement note:\n${preview.placementNote}`,
          preview.placementCaption && `Image caption:\n${preview.placementCaption}`].filter(Boolean).join('\n\n')
        : preview.broaderAnswer,
      placementMode: preview.placementMode,
      selectedAnchorNodeId: preview.selectedAnchorNodeId,
      selectedAnchorBreadcrumb: preview.selectedAnchorBreadcrumb,
      generatedPathTitles: preview.generatedPathTitles,
      plannedLeafParentBreadcrumb: preview.plannedLeafParentBreadcrumb,
      generatedLeafTitle: preview.generatedLeafTitle,
      attachmentFile,
      preserveNoteWhitespace: preview.saveKind === 'note' && Boolean(preview.uploadId),
    });
    const noteSearchParams = new URLSearchParams({
      treeId: String(savedLeaf.treeId),
      nodeId: String(savedLeaf.updatedNodeId ?? savedLeaf.createdNodeId),
      visibility: writableTree.isPrivate ? 'private' : 'public',
    });

    const toolOutput = {
      ...savedLeaf,
      saveMode,
      saveKind: preview.saveKind,
      fileName: attachmentFile?.name ?? null,
      treeName: preview.treeName,
      noteLink: `[View ${attachmentFile ? 'attachment' : 'note'}](/notes?${noteSearchParams.toString()})`,
    };
    delete toolOutput.flatData;

    return buildPersistenceToolHandlerResult({
      toolName: confirmAddToTreeToolDefinition.name,
      toolResultType: attachmentFile ? 'tree_attachment_saved' : saveMode === 'merge_existing' ? 'tree_note_updated' : 'tree_note_created',
      toolOutput,
      untrustedDataPaths: [
        'treeName', 'selectedAnchorBreadcrumb', 'plannedLeafParentBreadcrumb',
        'generatedLeafTitle', 'createdIntermediateNodes', 'mergeBreadcrumb',
        'details.name', 'details.notes', 'details.attachments',
      ],
      includeDebug,
    });
  };
}