import { attachDebugToError } from '@/server/utils/agent/agentDebug';
import {
  invalidateLatestEmailRetrievalSnapshot,
  loadCachedEmailMessage,
  updateCachedEmailMessageFlags,
} from '@/server/utils/agent/email/emailCacheRepository';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import { loadEmailAccountConfig } from '@/server/utils/agent/email/emailAccountConfigRepository';
import { updateImapMessageFlags } from '@/server/utils/agent/email/emailTransport';

export const FLAG_EMAIL_TOOL = 'flag_email';

export const flagEmailToolDefinition = {
  type: 'function',
  name: FLAG_EMAIL_TOOL,
  description: 'Add or remove IMAP flags such as \\Seen, \\Flagged, or \\Answered for one email.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      folder: { type: 'string' },
      uid: { type: 'string' },
      mode: { type: 'string', enum: ['add', 'remove'] },
      flags: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['provider', 'folder', 'uid', 'mode', 'flags'],
    additionalProperties: false,
  },
};

export function buildFlagEmailHandler({ includeDebug = false, updatedBy = null, personalCacheTreeId = null } = {}) {
  return async function flagEmailHandler(args, agentContext = null) {
    const resolvedTreeId = agentContext?.personalCacheTreeId ?? personalCacheTreeId ?? null;
    const resolvedUpdatedBy = agentContext?.updatedBy ?? updatedBy ?? null;

    try {
      if (!resolvedTreeId) {
        throw new Error('A personal cache tree id is required to update email flags.');
      }

      const { accountConfig } = await loadEmailAccountConfig({
        treeId: resolvedTreeId,
        provider: args.provider,
      });
      const output = await updateImapMessageFlags(accountConfig, args);
      let messageCacheUpdated = false;
      let snapshotInvalidated = false;

      try {
        const cachedMessage = await loadCachedEmailMessage({
          treeId: resolvedTreeId,
          provider: args.provider,
          uid: args.uid,
        });

        if (cachedMessage) {
          const currentFlags = Array.isArray(cachedMessage.flags) ? cachedMessage.flags : [];
          const requestedFlags = Array.isArray(output.flags) ? output.flags : [];
          const nextFlags = output.mode === 'remove'
            ? currentFlags.filter((flag) => !requestedFlags.includes(flag))
            : Array.from(new Set([...currentFlags, ...requestedFlags]));

          messageCacheUpdated = await updateCachedEmailMessageFlags({
            treeId: resolvedTreeId,
            provider: args.provider,
            uid: args.uid,
            flags: nextFlags,
            updatedBy: resolvedUpdatedBy,
          });
        }
      } catch {
        messageCacheUpdated = false;
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
        toolName: FLAG_EMAIL_TOOL,
        toolResultType: 'email_flag_update',
        data: output,
        includeDebug,
        debug: includeDebug ? {
          ...output,
          messageCacheUpdated,
          snapshotInvalidated,
        } : null,
      });
    } catch (error) {
      throw attachDebugToError(error, includeDebug ? args : null);
    }
  };
}