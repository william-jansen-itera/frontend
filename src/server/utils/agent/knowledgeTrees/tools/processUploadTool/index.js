import { QueueClient } from '@azure/storage-queue';
import { buildAgentToolResult, buildUntrustedContentMeta } from '@/server/utils/agent/agentToolResult';
import { getAuditMetadata } from '@/server/utils/tree/treeCatalog';
import {
  failQueuedChatUpload,
  getOwnedChatUpload,
  queueOwnedChatUpload,
} from '@/server/utils/agent/knowledgeTrees/chatUploadRepository';
import { KNOWLEDGE_TREES_FAMILY } from '@/server/utils/agent/knowledgeTrees/tools/persistenceToolShared';

export const processUploadToolDefinition = {
  type: 'function',
  name: 'process_upload',
  description: 'Process the one file attached to this chat turn and return a short, temporary, factual placement note. This does not preview, approve, or save anything to a tree.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      uploadId: { type: 'string', description: 'Opaque upload ID provided for this turn by the server.' },
    },
    required: ['uploadId'],
    additionalProperties: false,
  },
};

export function createProcessUploadHandler({ principal, currentUploadId }) {
  return async ({ uploadId }) => {
    if (!currentUploadId || uploadId !== currentUploadId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
      throw new Error('This upload was not attached to the current chat turn.');
    }
    const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;
    if (!ownerObjectId) throw new Error('An authenticated user is required to process an upload.');
    let upload = await getOwnedChatUpload({ uploadId, ownerObjectId });
    if (!upload) throw new Error('Upload was not found or has expired.');

    if (await queueOwnedChatUpload({ uploadId, ownerObjectId })) {
      let queueStep = 'configure';
      try {
        const connection = process.env.CHAT_UPLOAD_STORAGE_CONNECTION_STRING;
        if (!connection) throw new Error('Upload queue storage is not configured.');
        const queue = new QueueClient(connection, 'chat-upload-jobs');
        queueStep = 'create';
        await queue.createIfNotExists();
        queueStep = 'send';
        await queue.sendMessage(Buffer.from(JSON.stringify({ uploadId })).toString('base64'));
      } catch (error) {
        console.error('Chat upload queue failed', {
          uploadId,
          step: queueStep,
          code: typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/i.test(error.code) ? error.code : undefined,
          statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : undefined,
        });
        await failQueuedChatUpload(uploadId);
        throw new Error('Could not queue chat upload processing.', { cause: error });
      }
      upload = { ...upload, status: 'queued' };
    }

    const data = {
      uploadId,
      status: upload.status,
      fileName: upload.fileName,
      note: upload.status === 'succeeded' ? upload.note : null,
      failureSummary: upload.status === 'failed' ? upload.failureSummary : null,
    };
    return buildAgentToolResult({
      sourceToolFamily: KNOWLEDGE_TREES_FAMILY,
      toolName: processUploadToolDefinition.name,
      toolResultType: 'temporary_upload_note',
      data,
      meta: buildUntrustedContentMeta(data, ['fileName', 'note']),
    });
  };
}