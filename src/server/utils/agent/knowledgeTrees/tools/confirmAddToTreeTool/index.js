import { createLeafNodeFromChat, createTreeNodeAttachment, mergeLeafNodeFromChat, normalizeUpdatedByMetadata } from '@/server/utils/tree/treeMutationService';
import { getOwnedChatUpload } from '@/server/utils/agent/knowledgeTrees/chatUploadRepository';
import { readVerifiedStagingFile } from '@/server/utils/agent/knowledgeTrees/stagingBlob';
import { getAuditMetadata } from '@/server/utils/tree/treeCatalog';
import { consumeTreePreviewSnapshot, getTreePreviewSnapshot } from '@/server/utils/agent/knowledgeTrees/tools/treePreviewSnapshotRepository';
import {
  assertWritableRuntimeTree,
  buildPersistenceToolHandlerResult,
  buildTreePreviewToolOutput,
} from '@/server/utils/agent/knowledgeTrees/tools/persistenceToolShared';

export const confirmAddToTreeToolDefinition = {
  type: 'function',
  name: 'confirm_save_to_tree',
  description: 'Save only after the user approves the preview shown in the immediately preceding assistant reply with its Preview ID marker. A yes to a broad answer\'s save offer requires preview_save_to_tree first; it does not authorize confirmation, even when an older preview exists in history. Never invent a previewId or reuse an older preview for newer content. Choose saveMode only from that preview\'s availableSaveModes. If exactly one mode is offered, use that exact value. Otherwise use defaultSaveMode unless the human explicitly chooses another offered mode. For an unqualified approval, copy defaultConfirmArguments exactly. Never infer the mode from file type, path wording, or previous previews. Use only the latest previewId, including a revised previewId when the path was changed. Follow tool error recovery guidance; a missing or invalid ID is not proof of expiry.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      previewId: {
        type: 'string',
        description: 'Copy the exact previewId of the latest human-approved preview returned by preview_save_to_tree or revise_save_preview, never an older previewId.',
      },
      saveMode: {
        type: 'string',
        enum: ['merge_existing', 'create_leaf'],
        description: 'Copy the sole value in the latest approved preview\'s availableSaveModes. If multiple modes are offered, use defaultConfirmArguments.saveMode unless the human explicitly chooses another offered mode. Never infer the mode from file type or path wording.',
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
    if (offeredPreview.uploadId && (typeof offeredPreview.incomingNotes !== 'string' ||
        !offeredPreview.incomingNotes.trim() || offeredPreview.incomingNotes.length > 4000)) {
      throw new Error('The upload preview has no valid frozen incoming notes. Preview again.');
    }
    const createAvailable = Boolean(offeredPreview.createPath) &&
      offeredPreview.createPath.toLowerCase() !== offeredPreview.mergeTarget?.breadcrumb?.toLowerCase();
    if ((saveMode !== 'merge_existing' || !offeredPreview.mergeTarget) &&
        (saveMode !== 'create_leaf' || !createAvailable)) {
      const { availableSaveModes, defaultConfirmArguments } = buildTreePreviewToolOutput(previewId, offeredPreview);
      throw new Error(`That save mode was not offered for this preview. Nothing was saved and the preview was not consumed. ${JSON.stringify({ availableSaveModes, defaultConfirmArguments })}. If the human approved the default, retry confirm_save_to_tree with these exact defaultConfirmArguments. Do not silently substitute a mode. If the human requested an unoffered action, use revise_save_preview for a different complete path and wait for approval of that new preview.`);
    }
    let attachmentFile = null;
    if (offeredPreview.uploadId) {
      const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;
      const upload = ownerObjectId && await getOwnedChatUpload({ uploadId: offeredPreview.uploadId, ownerObjectId });
      if (!upload || upload.status !== 'succeeded' || upload.saveKind !== offeredPreview.saveKind ||
          upload.fileName !== offeredPreview.fileName || upload.byteSize !== offeredPreview.byteSize ||
          upload.sha256 !== offeredPreview.sha256 ||
          String(upload.originalHumanMessage ?? '').trim() !== String(offeredPreview.userDescription ?? '').trim() &&
            !String(upload.originalHumanMessage ?? '').includes(String(offeredPreview.userDescription ?? '')) ||
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
      broaderAnswer: preview.uploadId ? preview.incomingNotes : preview.broaderAnswer,
      placementMode: preview.placementMode,
      selectedAnchorNodeId: preview.selectedAnchorNodeId,
      selectedAnchorBreadcrumb: preview.selectedAnchorBreadcrumb,
      generatedPathTitles: preview.generatedPathTitles,
      plannedLeafParentBreadcrumb: preview.plannedLeafParentBreadcrumb,
      generatedLeafTitle: preview.generatedLeafTitle,
      attachmentFile,
      preserveNoteWhitespace: Boolean(preview.uploadId),
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