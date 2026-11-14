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

function buildUploadIncomingNotes(upload, { userDescription, userClarification, placementNote, placementCaption }) {
  const sections = [
    ['User description', userDescription],
    ['User clarification', userClarification],
    ['Document extraction (verbatim)', upload.saveKind === 'note' ? upload.extractedNoteText : ''],
    ['Processed placement note', placementNote],
    ['Generated image caption', placementCaption],
  ];
  const notes = sections.filter(([, text]) => String(text ?? '').trim())
    .map(([label, text]) => `${label}:\n${String(text)}`).join('\n\n');
  if (notes.length > 4000) {
    throw new Error('The labeled upload notes exceed 4000 characters. Shorten the human context or choose another way to save this file.');
  }
  return notes;
}

export const previewAddToTreeToolDefinition = {
  type: 'function',
  name: 'preview_save_to_tree',
  description: 'Prepare a preview without saving; final save approval is not required to call this tool when the original request authorizes previewing. Ask for final human approval only after displaying the returned preview. When the human accepts an offer to save an already-delivered broad answer, use contentSource="prior_broad_answer" and that answer from history, not current_user_text: a yes is acceptance, not note text. Use current_user_text only for factual text actually supplied in the current human message. Use completed_upload_note for a server-authorized classified upload; an existing leaf receives the original file without changing notes, and a new leaf receives the file and available labeled placement evidence.',
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
        description: 'For prior_broad_answer, copy the accepted, already-delivered broad answer from history, cleaning dialogue without adding facts; never substitute the human approval text or require the human to repeat the answer. For current_user_text, a verbatim factual excerpt actually present in the current human message, excluding the save request. For completed_upload_note, use an empty string; the server supplies the note.',
      },
      contentSource: {
        type: 'string',
        enum: ['current_user_text', 'prior_broad_answer', 'completed_upload_note'],
        description: 'Select by the origin of the substantive text, not the message asking to save it. An accepted offer to save an earlier broad answer requires prior_broad_answer, including when the latest human message is only yes. current_user_text requires new factual text in the current human message; approval alone does not qualify. completed_upload_note requires a server-authorized completed upload.',
      },
      uploadId: {
        type: 'string',
        description: 'For completed_upload_note, the upload ID in the automated completion message; otherwise use an empty string.',
      },
      userDescription: {
        type: 'string',
        description: 'For an upload, an exact excerpt of the original typed human upload message, or empty. The server verifies it against the owned upload. Otherwise use an empty string.',
      },
      userClarification: {
        type: 'string',
        description: 'For a pending upload, an exact excerpt of new factual detail in this human reply, or empty. A yes, no, or request to use available evidence adds no facts. Otherwise use an empty string.',
      },
    },
    required: ['toolName', 'originalQuestion', 'broaderAnswer', 'contentSource', 'uploadId', 'userDescription', 'userClarification'],
    additionalProperties: false,
  },
};

export function createPreviewAddToTreeHandler({ includedTrees, principal, includeDebug, currentUserMessage, currentUploadId = null, previewUploadId = null, pendingUploadId = null }) {
  return async ({ toolName, originalQuestion, broaderAnswer, contentSource, uploadId, userDescription = '', userClarification = '' }) => {
    if (previewUploadId && contentSource !== 'completed_upload_note') {
      throw new Error('Only the completed upload note can be previewed in this turn.');
    }
    if (contentSource !== 'completed_upload_note' && uploadId) {
      throw new Error('An upload ID is only valid for a completed upload preview.');
    }
    if (contentSource !== 'completed_upload_note' && (userDescription || userClarification)) {
      throw new Error('Human upload context is only valid for a completed upload preview.');
    }
    let noteText = broaderAnswer;
    let placementCaption = '';
    let uploadPayload = null;
    if (contentSource === 'current_user_text') {
      const content = String(broaderAnswer ?? '').trim();
      const message = String(currentUserMessage ?? '').trim();
      if (!content || content === message || !message.includes(content)) {
        throw new Error('contentSource="current_user_text" requires factual note text taken from the current user message, not approval alone. If the user accepted an offer to save a specific earlier broad answer, retry with contentSource="prior_broad_answer" and that already-delivered answer from history; do not ask the user to repeat an available answer. Otherwise request the factual text to save.');
      }
    } else if (contentSource === 'completed_upload_note') {
      const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;
      if ((!previewUploadId && !pendingUploadId) || uploadId !== (previewUploadId || pendingUploadId) || !ownerObjectId) {
        throw new Error('A completed upload must be authorized for this preview.');
      }
      const upload = await getOwnedChatUpload({ uploadId, ownerObjectId });
      if (upload?.status !== 'succeeded' || !['note', 'attachment'].includes(upload.saveKind) ||
          (upload.saveKind === 'note' && (!String(upload.extractedNoteText ?? '').trim() || upload.extractedNoteText.length > 4000))) {
        throw new Error('The completed upload classification is not available for preview. Upload the file again.');
      }
      const placementNote = String(upload.note ?? '').trim();
      const originalHumanMessage = String(upload.originalHumanMessage ?? '').trim();
      const description = String(userDescription ?? '').trim();
      const clarification = String(userClarification ?? '').trim();
      if (description && !originalHumanMessage.includes(description)) {
        throw new Error('The upload description must be taken from the original human message.');
      }
      if (clarification && (!pendingUploadId || !String(currentUserMessage ?? '').includes(clarification))) {
        throw new Error('The upload clarification must be taken from the current human reply.');
      }
      const verifiedDescription = description;
      const verifiedClarification = /^(?:yes|no|ja|nej|use what is available|brug det(?:,? som)? er tilgængeligt)[.!]?$/i.test(clarification)
        ? '' : clarification;
      noteText = placementNote;
      placementCaption = String(upload.caption ?? '').trim();
      if (!noteText && !placementCaption && !verifiedDescription && !verifiedClarification) {
        throw new Error('This upload needs a human-provided topic before previewing.');
      }
      noteText ||= placementCaption || verifiedDescription || verifiedClarification;
      uploadPayload = {
        saveKind: upload.saveKind,
        uploadId,
        fileName: upload.fileName,
        byteSize: upload.byteSize,
        sha256: upload.sha256,
        placementNote,
        placementCaption,
        userDescription: verifiedDescription,
        userClarification: verifiedClarification,
        ...(upload.saveKind === 'note' ? { extractedNoteText: upload.extractedNoteText } : {}),
      };
      uploadPayload.incomingNotes = buildUploadIncomingNotes(upload, uploadPayload);
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
    const placementPreview = await previewLeafFromChat({
      treeInstanceId: Number.parseInt(resolvedTreeId, 10),
      originalQuestion,
      broaderAnswer: noteText,
      placementCaption,
      uploadContext: uploadPayload ? {
        userDescription: uploadPayload.userDescription,
        userClarification: uploadPayload.userClarification,
        placementNote: uploadPayload.placementNote,
        placementCaption,
        fileName: uploadPayload.fileName,
      } : null,
      onModelCall: includeDebug ? (call) => selectionCalls.push(call) : undefined,
    });
    const preview = uploadPayload
      ? { ...placementPreview, ...uploadPayload, broaderAnswer: uploadPayload.saveKind === 'note' ? uploadPayload.incomingNotes : uploadPayload.placementNote }
      : { ...placementPreview, saveKind: 'note' };

    const previewId = randomUUID();
    await storeTreePreviewSnapshot({ previewId, preview, principal });

    return buildPersistenceToolHandlerResult({
      toolName: previewAddToTreeToolDefinition.name,
      toolResultType: 'tree_note_preview',
      toolOutput: buildTreePreviewToolOutput(previewId, preview),
      untrustedDataPaths: ['treeName', 'createPath', 'mergePath', 'defaultSavePath', 'fileName', 'createLeafNotes', 'incomingNotes'],
      includeDebug,
      debug: { placementSelection: { modelCallCount: selectionCalls.length, calls: selectionCalls } },
    });
  };
}
