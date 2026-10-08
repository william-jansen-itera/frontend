import { appendDebugStep, attachDebugToError } from '@/server/utils/agent/agentDebug';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import {
  loadCachedEmailMessage,
  loadLatestEmailRetrievalSnapshot,
  storeCachedEmailMessage,
} from '@/server/utils/agent/email/emailCacheRepository';

export const SHOW_EMAIL_TOOL = 'show_email';

export const showEmailToolDefinition = {
  type: 'function',
  name: SHOW_EMAIL_TOOL,
  description: 'Display one cached email without model analysis by returning the stored message fields and body text for a UID copied from retrieve_emails.',
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
    },
    required: ['provider', 'folder', 'uid'],
    additionalProperties: false,
  },
};

function buildShownEmail(message) {
  return {
    uid: String(message?.uid ?? '').trim() || null,
    messageId: message?.messageId ?? null,
    threadId: message?.threadId ?? null,
    folder: message?.folder ?? null,
    from: message?.from ?? null,
    to: Array.isArray(message?.to) ? message.to : [],
    cc: Array.isArray(message?.cc) ? message.cc : [],
    subject: message?.subject ?? null,
    receivedAt: message?.receivedAt ?? null,
    flags: Array.isArray(message?.flags) ? message.flags : [],
    preview: message?.preview ?? null,
    bodyText: message?.bodyText ?? null,
    heuristicClassification: message?.heuristicCache?.classification ?? null,
    replyItems: Array.isArray(message?.heuristicCache?.replyItems)
      ? message.heuristicCache.replyItems
      : Array.isArray(message?.heuristicCache?.replyMatches)
        ? message.heuristicCache.replyMatches
        : [],
    actionItems: Array.isArray(message?.heuristicCache?.actionItems)
      ? message.heuristicCache.actionItems
      : [],
    deadlineItems: Array.isArray(message?.heuristicCache?.deadlineItems)
      ? message.heuristicCache.deadlineItems
      : Array.isArray(message?.heuristicCache?.deadlines)
        ? message.heuristicCache.deadlines
        : [],
  };
}

export function buildShowEmailHandler({ includeDebug = false, updatedBy = null, personalCacheTreeId = null } = {}) {
  return async function showEmailHandler(args, agentContext = null) {
    const resolvedTreeId = agentContext?.personalCacheTreeId ?? personalCacheTreeId ?? null;
    const resolvedUpdatedBy = agentContext?.updatedBy ?? updatedBy ?? null;
    const agentDebug = agentContext?.debug ?? null;
    const emitStep = (step, details = null) => {
      if (includeDebug && agentDebug) {
        appendDebugStep(agentDebug, step, details);
      }
    };

    try {
      if (!resolvedTreeId) {
        throw new Error('A personal cache tree id is required to show an email.');
      }

      const normalizedFolder = String(args.folder ?? 'INBOX').trim() || 'INBOX';
      const normalizedUid = String(args.uid ?? '').trim();

      if (!normalizedUid) {
        throw new Error('A cached email uid is required to show email.');
      }

      emitStep('tool show_email checking cached message', {
        uid: normalizedUid,
      });
      let message = await loadCachedEmailMessage({
        treeId: resolvedTreeId,
        provider: args.provider,
        uid: normalizedUid,
      });

      if (!message) {
        emitStep('tool show_email checking retrieval snapshot', {
          uid: normalizedUid,
          folder: normalizedFolder,
        });
        const snapshot = await loadLatestEmailRetrievalSnapshot({
          treeId: resolvedTreeId,
          provider: args.provider,
          folder: normalizedFolder,
        });
        const snapshotMessages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];

        message = snapshotMessages.find((entry) => String(entry?.uid ?? '').trim() === normalizedUid) ?? null;

        if (message) {
          emitStep('tool show_email found message in retrieval snapshot', {
            uid: normalizedUid,
            folder: normalizedFolder,
            snapshotCreatedAt: snapshot?.createdAt ?? null,
          });
          await storeCachedEmailMessage({
            treeId: resolvedTreeId,
            provider: args.provider,
            uid: message.uid,
            message,
            updatedBy: resolvedUpdatedBy,
          });
        } else if (snapshotMessages.length > 0) {
          throw new Error(
            `Wrong message uid was provided: ${normalizedUid}. The requested email does not match any message in the latest retrieval snapshot for folder ${normalizedFolder}.`,
          );
        }
      }

      if (!message) {
        throw new Error(
          `Email uid ${normalizedUid} is not available in the current cache for folder ${normalizedFolder}. Retrieve emails for that folder first, then show one of the returned UIDs.`,
        );
      }

      return buildEmailToolResult({
        toolName: SHOW_EMAIL_TOOL,
        toolResultType: 'email_show',
        data: {
          provider: args.provider,
          folder: normalizedFolder,
          email: buildShownEmail(message),
        },
        includeDebug,
        debug: includeDebug ? {
          uid: normalizedUid,
          folder: normalizedFolder,
        } : null,
      });
    } catch (error) {
      throw attachDebugToError(error, includeDebug ? {
        provider: args?.provider ?? null,
        folder: args?.folder ?? null,
        uid: args?.uid ?? null,
      } : null);
    }
  };
}