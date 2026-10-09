import { attachDebugToError } from '@/server/utils/agent/agentDebug';
import {
  loadCachedEmailMessage,
  updateLatestEmailRetrievalSnapshotFlags,
  updateCachedEmailMessageFlags,
} from '@/server/utils/agent/email/emailCacheRepository';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import { loadEmailAccountConfig } from '@/server/utils/agent/email/emailAccountConfigRepository';
import { updateImapMessageFlags } from '@/server/utils/agent/email/emailTransport';

export const FLAG_EMAIL_TOOL = 'flag_email';
const FLAG_EMAIL_IMAP_FLAG = '\\Flagged';

export const flagEmailToolDefinition = {
  type: 'function',
  name: FLAG_EMAIL_TOOL,
  description: 'Set or remove the visual flagged or starred state on one or more emails.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      folder: { type: 'string' },
      uids: {
        description: 'Strings copied unchanged from data.emails[].uid in the latest retrieve_emails result. Do not use the array index, data.resultCount, meta.resultCount, or any value not present in data.emails[].uid.',
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
      },
      mode: { type: 'string', enum: ['add', 'remove'] },
    },
    required: ['provider', 'folder', 'uids', 'mode'],
    additionalProperties: false,
  },
};

function normalizeFlagTargetUids(args) {
  const uidValues = [];

  for (const uid of Array.isArray(args?.uids) ? args.uids : []) {
    const normalizedUid = String(uid ?? '').trim();

    if (normalizedUid) {
      uidValues.push(normalizedUid);
    }
  }

  return Array.from(new Set(uidValues));
}

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
      const targetUids = normalizeFlagTargetUids(args);

      if (targetUids.length === 0) {
        throw new Error('At least one email uid is required to update the flagged state.');
      }

      const output = await updateImapMessageFlags(accountConfig, {
        folder: args.folder,
        uids: targetUids,
        flags: [FLAG_EMAIL_IMAP_FLAG],
        mode: args.mode,
      });
      let messageCacheUpdatedCount = 0;
      let snapshotUpdated = false;

      try {
        for (const uid of targetUids) {
          const cachedMessage = await loadCachedEmailMessage({
            treeId: resolvedTreeId,
            provider: args.provider,
            folder: args.folder,
            uid,
          });

          if (!cachedMessage) {
            continue;
          }

          const currentFlags = Array.isArray(cachedMessage.flags) ? cachedMessage.flags : [];
          const requestedFlags = Array.isArray(output.flags) ? output.flags : [];
          const nextFlags = output.mode === 'remove'
            ? currentFlags.filter((flag) => !requestedFlags.includes(flag))
            : Array.from(new Set([...currentFlags, ...requestedFlags]));

          const cacheUpdated = await updateCachedEmailMessageFlags({
            treeId: resolvedTreeId,
            provider: args.provider,
            folder: args.folder,
            uid,
            flags: nextFlags,
            updatedBy: resolvedUpdatedBy,
          });

          if (cacheUpdated) {
            messageCacheUpdatedCount += 1;
          }
        }
      } catch {
        messageCacheUpdatedCount = 0;
      }

      try {
        snapshotUpdated = await updateLatestEmailRetrievalSnapshotFlags({
          treeId: resolvedTreeId,
          provider: args.provider,
          folder: args.folder,
          uids: targetUids,
          flags: Array.isArray(output.flags) ? output.flags : [],
          updatedBy: resolvedUpdatedBy,
        });
      } catch {
        snapshotUpdated = false;
      }

      return buildEmailToolResult({
        toolName: FLAG_EMAIL_TOOL,
        toolResultType: 'email_flag_update',
        data: output,
        includeDebug,
        debug: includeDebug ? {
          ...output,
          messageCacheUpdatedCount,
          snapshotUpdated,
        } : null,
      });
    } catch (error) {
      throw attachDebugToError(error, includeDebug ? args : null);
    }
  };
}