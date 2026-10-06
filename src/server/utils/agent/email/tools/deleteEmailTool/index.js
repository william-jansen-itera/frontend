import { attachDebugToError } from '@/server/utils/agent/agentDebug';
import {
  invalidateCachedEmailMessage,
  invalidateLatestEmailRetrievalSnapshot,
} from '@/server/utils/agent/email/emailCacheRepository';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import { loadEmailAccountConfig } from '@/server/utils/agent/email/emailAccountConfigRepository';
import { deleteImapMessage } from '@/server/utils/agent/email/emailTransport';

export const DELETE_EMAIL_TOOL = 'delete_email';

export const deleteEmailToolDefinition = {
  type: 'function',
  name: DELETE_EMAIL_TOOL,
  description: 'Mark one email as deleted and optionally expunge it from the mailbox.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      folder: { type: 'string' },
      uid: { type: 'string' },
      expunge: { type: 'boolean' },
    },
    required: ['provider', 'folder', 'uid', 'expunge'],
    additionalProperties: false,
  },
};

export function buildDeleteEmailHandler({ includeDebug = false, updatedBy = null, personalCacheTreeId = null } = {}) {
  return async function deleteEmailHandler(args, agentContext = null) {
    const resolvedTreeId = agentContext?.personalCacheTreeId ?? personalCacheTreeId ?? null;
    const resolvedUpdatedBy = agentContext?.updatedBy ?? updatedBy ?? null;

    try {
      if (!resolvedTreeId) {
        throw new Error('A personal cache tree id is required to delete email.');
      }

      const { accountConfig } = await loadEmailAccountConfig({
        treeId: resolvedTreeId,
        provider: args.provider,
      });
      const output = await deleteImapMessage(accountConfig, args);
      let messageCacheInvalidated = false;
      let snapshotInvalidated = false;

      try {
        await invalidateCachedEmailMessage({
          treeId: resolvedTreeId,
          provider: args.provider,
          uid: args.uid,
          updatedBy: resolvedUpdatedBy,
        });
        messageCacheInvalidated = true;
      } catch {
        messageCacheInvalidated = false;
      }

      try {
        snapshotInvalidated = await invalidateLatestEmailRetrievalSnapshot({
          treeId: resolvedTreeId,
          provider: args.provider,
          folder: args.folder,
          updatedBy: resolvedUpdatedBy,
        });
      } catch {
        snapshotInvalidated = false;
      }

      return buildEmailToolResult({
        toolName: DELETE_EMAIL_TOOL,
        toolResultType: 'email_delete',
        data: output,
        includeDebug,
        debug: includeDebug ? {
          ...output,
          messageCacheInvalidated,
          snapshotInvalidated,
        } : null,
      });
    } catch (error) {
      throw attachDebugToError(error, includeDebug ? args : null);
    }
  };
}