import { appendDebugStep, attachDebugToError } from '@/server/utils/agent/agentDebug';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import { buildExposedUnsubscribeMetadata } from '@/server/utils/agent/email/emailTransport';
import {
  loadCachedEmailMessage,
  loadLatestEmailRetrievalSnapshot,
  storeCachedEmailMessage,
} from '@/server/utils/agent/email/emailCacheRepository';

export const SHOW_EMAIL_TOOL = 'show_email';

export const showEmailToolDefinition = {
  type: 'function',
  name: SHOW_EMAIL_TOOL,
  description: 'Display one or more cached emails without model analysis by returning the stored message fields and body text for UIDs copied from retrieve_emails. Pass every target in one uids array. The response always returns data.emails, including for a single email.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      folder: {
        type: 'string',
        description: 'Same folder value used in the retrieve_emails call that returned these UIDs.',
      },
      uids: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'Strings copied unchanged from data.emails[].uid in the latest retrieve_emails result. Do not use the array index, data.resultCount, meta.resultCount, or any value not present in data.emails[].uid.',
      },
    },
    required: ['provider', 'folder', 'uids'],
    additionalProperties: false,
  },
};

function normalizeShowTargetUids(args) {
  const uidValues = [];

  for (const uid of Array.isArray(args?.uids) ? args.uids : []) {
    const normalizedUid = String(uid ?? '').trim();

    if (normalizedUid) {
      uidValues.push(normalizedUid);
    }
  }

  return Array.from(new Set(uidValues));
}

function buildShownEmail(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const analysisCache = message?.analysisCache && typeof message.analysisCache === 'object'
    ? message.analysisCache
    : null;
  const storedHeuristics = message?.heuristicCache && typeof message.heuristicCache === 'object'
    ? message.heuristicCache
    : null;
  const classification = analysisCache?.classification ?? storedHeuristics?.classification ?? null;
  const replyItems = Array.isArray(analysisCache?.replyItems)
    ? analysisCache.replyItems
    : Array.isArray(storedHeuristics?.replyItems)
      ? storedHeuristics.replyItems
      : Array.isArray(storedHeuristics?.replyMatches)
        ? storedHeuristics.replyMatches
        : [];
  const actionItems = Array.isArray(analysisCache?.actionItems)
    ? analysisCache.actionItems
    : Array.isArray(storedHeuristics?.actionItems)
      ? storedHeuristics.actionItems
      : [];
  const deadlineItems = Array.isArray(analysisCache?.deadlineItems)
    ? analysisCache.deadlineItems
    : Array.isArray(storedHeuristics?.deadlineItems)
      ? storedHeuristics.deadlineItems
      : Array.isArray(storedHeuristics?.deadlines)
        ? storedHeuristics.deadlines
        : [];

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
    unsubscribe: buildExposedUnsubscribeMetadata(message?.unsubscribe),
    attachments,
    attachmentCount: attachments.length,
    attachmentFileNames: attachments.map((attachment) => String(attachment?.fileName ?? '').trim()).filter(Boolean),
    heuristicClassification: classification,
    analysisCache,
    replyItems,
    actionItems,
    deadlineItems,
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
      const normalizedUids = normalizeShowTargetUids(args);

      if (normalizedUids.length === 0) {
        throw new Error('At least one cached email uid is required to show email.');
      }

      const snapshot = await loadLatestEmailRetrievalSnapshot({
        treeId: resolvedTreeId,
        principal: agentContext?.principal,
        provider: args.provider,
        folder: normalizedFolder,
      });
      const snapshotMessages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
      const shownMessages = [];

      for (const normalizedUid of normalizedUids) {
        emitStep('tool show_email checking cached message', {
          uid: normalizedUid,
        });
        let message = await loadCachedEmailMessage({
          treeId: resolvedTreeId,
          principal: agentContext?.principal,
          provider: args.provider,
          folder: normalizedFolder,
          uid: normalizedUid,
        });

        if (!message) {
          emitStep('tool show_email checking retrieval snapshot', {
            uid: normalizedUid,
            folder: normalizedFolder,
          });

          message = snapshotMessages.find((entry) => String(entry?.uid ?? '').trim() === normalizedUid) ?? null;

          if (message) {
            emitStep('tool show_email found message in retrieval snapshot', {
              uid: normalizedUid,
              folder: normalizedFolder,
              snapshotCreatedAt: snapshot?.createdAt ?? null,
            });
            await storeCachedEmailMessage({
              treeId: resolvedTreeId,
              principal: agentContext?.principal,
              provider: args.provider,
              folder: normalizedFolder,
              uid: message.uid,
              message,
              updatedBy: resolvedUpdatedBy,
            });
          } else if (snapshotMessages.length > 0) {
            throw new Error(
              `Wrong message uid was provided: ${normalizedUid}. This uid does not exist in the latest retrieve_emails result for folder ${normalizedFolder} in this conversation. Look up data.emails[].uid in that latest retrieve_emails result and retry with one of those exact uid strings. Do not invent or transform the uid.`,
            );
          }
        }

        if (!message) {
          throw new Error(
            `Email uid ${normalizedUid} is not available in the current cache for folder ${normalizedFolder}. Run retrieve_emails for that folder, then look up data.emails[].uid in the latest retrieve_emails result in this conversation and retry with one of those exact uid strings. Do not invent or transform the uid.`,
          );
        }

        shownMessages.push(buildShownEmail(message));
      }

      return buildEmailToolResult({
        toolName: SHOW_EMAIL_TOOL,
        toolResultType: 'email_show',
        data: {
          provider: args.provider,
          folder: normalizedFolder,
          emails: shownMessages,
        },
        includeDebug,
        debug: includeDebug ? {
          uids: normalizedUids,
          folder: normalizedFolder,
        } : null,
      });
    } catch (error) {
      throw attachDebugToError(error, includeDebug ? {
        provider: args?.provider ?? null,
        folder: args?.folder ?? null,
        uids: Array.isArray(args?.uids) ? args.uids : null,
      } : null);
    }
  };
}