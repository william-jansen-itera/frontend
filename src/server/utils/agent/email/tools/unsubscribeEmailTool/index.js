import { attachDebugToError } from '@/server/utils/agent/agentDebug';
import {
  loadCachedEmailMessage,
  loadLatestEmailRetrievalSnapshot,
  storeCachedEmailMessage,
} from '@/server/utils/agent/email/emailCacheRepository';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import { loadEmailAccountConfig } from '@/server/utils/agent/email/emailAccountConfigRepository';
import { buildExposedUnsubscribeMetadata } from '@/server/utils/agent/email/emailTransport';
import { unsubscribeViaMetadata } from '@/server/utils/agent/email/tools/unsubscribeEmailTool/unsubscribeExecution';

export const UNSUBSCRIBE_EMAIL_TOOL = 'unsubscribe_email';

export const unsubscribeEmailToolDefinition = {
  type: 'function',
  name: UNSUBSCRIBE_EMAIL_TOOL,
  description: 'Unsubscribe from one email only when retrieve_emails or one of the emails returned by show_email exposed unsubscribe metadata with unsubscribe.type equal to actionable and unsubscribe.hasLink equal to true. Requires explicit confirmation and supports automated HTTP(S) or mailto unsubscribe methods. For HTTP(S) results, the returned page text must be reviewed before concluding the unsubscribe actually completed.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      folder: {
        type: 'string',
        description: 'Same folder value used in the retrieve_emails call that returned this UID.',
      },
      uid: {
        type: 'string',
        description: 'String copied unchanged from data.emails[].uid in the latest retrieve_emails result. Do not use the array index, data.resultCount, meta.resultCount, or any value not present in data.emails[].uid.',
      },
      confirm: {
        type: 'boolean',
        description: 'Must be true to actually perform the unsubscribe action.',
      },
    },
    required: ['provider', 'folder', 'uid', 'confirm'],
    additionalProperties: false,
  },
};

async function resolveUnsubscribeTarget({ treeId, provider, folder, uid, updatedBy = null }) {
  const cachedMessage = await loadCachedEmailMessage({
    treeId,
    provider,
    folder,
    uid,
  });

  if (cachedMessage) {
    return cachedMessage;
  }

  const snapshot = await loadLatestEmailRetrievalSnapshot({
    treeId,
    provider,
    folder,
  });
  const snapshotMessages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const snapshotMessage = snapshotMessages.find((entry) => String(entry?.uid ?? '').trim() === uid) ?? null;

  if (snapshotMessage) {
    await storeCachedEmailMessage({
      treeId,
      provider,
      folder,
      uid,
      message: snapshotMessage,
      updatedBy,
    });

    return snapshotMessage;
  }

  if (snapshotMessages.length > 0) {
    throw new Error(
      `Wrong message uid was provided: ${uid}. This uid does not exist in the latest retrieve_emails result for folder ${folder} in this conversation. Look up data.emails[].uid in that latest retrieve_emails result and retry with one of those exact uid strings. Do not invent or transform the uid.`,
    );
  }

  throw new Error(
    `Email uid ${uid} is not available in the current cache for folder ${folder}. Run retrieve_emails for that folder, then look up data.emails[].uid in the latest retrieve_emails result in this conversation and retry with one of those exact uid strings. Do not invent or transform the uid.`,
  );
}

export function buildUnsubscribeEmailHandler({ includeDebug = false, updatedBy = null, personalCacheTreeId = null } = {}) {
  return async function unsubscribeEmailHandler(args, agentContext = null) {
    const resolvedTreeId = agentContext?.personalCacheTreeId ?? personalCacheTreeId ?? null;
    const resolvedUpdatedBy = agentContext?.updatedBy ?? updatedBy ?? null;

    try {
      if (!resolvedTreeId) {
        throw new Error('A personal cache tree id is required to unsubscribe from email.');
      }

      const normalizedFolder = String(args.folder ?? 'INBOX').trim() || 'INBOX';
      const normalizedUid = String(args.uid ?? '').trim();

      if (!normalizedUid) {
        throw new Error('An email uid is required to unsubscribe.');
      }

      if (args.confirm !== true) {
        throw new Error('Unsubscribe confirmation is required. Retry with confirm set to true only after the user explicitly confirms the unsubscribe action.');
      }

      const { accountConfig } = await loadEmailAccountConfig({
        treeId: resolvedTreeId,
        provider: args.provider,
      });
      const message = await resolveUnsubscribeTarget({
        treeId: resolvedTreeId,
        provider: args.provider,
        folder: normalizedFolder,
        uid: normalizedUid,
        updatedBy: resolvedUpdatedBy,
      });
      const unsubscribe = message?.unsubscribe && typeof message.unsubscribe === 'object'
        ? message.unsubscribe
        : null;
      const unsubscribeExecution = message?.unsubscribeExecution && typeof message.unsubscribeExecution === 'object'
        ? message.unsubscribeExecution
        : null;

      if (!unsubscribe?.hasLink) {
        throw new Error('This email does not expose an actionable unsubscribe link. Manual unsubscribe instructions, if any, must be followed by the agent from the email content.');
      }

      if (unsubscribe?.type !== 'actionable') {
        throw new Error('This email does not expose actionable unsubscribe metadata. The agent must explain the available unsubscribe instructions instead of calling unsubscribe_email.');
      }

      const action = await unsubscribeViaMetadata(accountConfig, unsubscribe, unsubscribeExecution);

      return buildEmailToolResult({
        toolName: UNSUBSCRIBE_EMAIL_TOOL,
        toolResultType: 'email_unsubscribe',
        data: {
          provider: args.provider,
          folder: normalizedFolder,
          uid: normalizedUid,
          subject: message?.subject ?? null,
          unsubscribe: buildExposedUnsubscribeMetadata(unsubscribe),
          action,
          unsubscribed: action?.actionType === 'email_send' ? true : null,
        },
        includeDebug,
        debug: includeDebug ? {
          provider: args.provider,
          folder: normalizedFolder,
          uid: normalizedUid,
          confirm: args.confirm === true,
          action,
        } : null,
      });
    } catch (error) {
      throw attachDebugToError(error, includeDebug ? args : null);
    }
  };
}