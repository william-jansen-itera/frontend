import { appendDebugStep, attachDebugToError } from '@/server/utils/agent/agentDebug';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import { loadEmailAccountConfig } from '@/server/utils/agent/email/emailAccountConfigRepository';
import { loadCachedEmailMessage, storeCachedEmailMessage } from '@/server/utils/agent/email/emailCacheRepository';
import { extractActionItems, extractDeadlines, summarizeEmailContent } from '@/server/utils/agent/email/emailHeuristics';
import { getImapMessageByUid } from '@/server/utils/agent/email/emailTransport';

export const SUMMARIZE_EMAIL_TOOL = 'summarize_email';

export const summarizeEmailToolDefinition = {
  type: 'function',
  name: SUMMARIZE_EMAIL_TOOL,
  description: 'Read one email or a small list of emails by UID and return concise summaries, key points, action items, and deadline mentions.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      folder: { type: 'string' },
      uid: { type: ['string', 'null'] },
      uids: {
        type: ['array', 'null'],
        items: { type: 'string' },
        minItems: 1,
        maxItems: 10,
      },
    },
    required: ['provider', 'folder', 'uid', 'uids'],
    additionalProperties: false,
  },
};

function buildKeyPoints(message) {
  return [
    message.subject ? `Subject: ${message.subject}` : null,
    message.from ? `From: ${message.from}` : null,
    message.preview ? `Preview: ${message.preview}` : null,
  ].filter(Boolean);
}

function normalizeSummaryTargetUids(args) {
  const uidValues = [];

  if (typeof args?.uid === 'string' && args.uid.trim()) {
    uidValues.push(args.uid.trim());
  }

  for (const uid of Array.isArray(args?.uids) ? args.uids : []) {
    const normalizedUid = String(uid ?? '').trim();

    if (normalizedUid) {
      uidValues.push(normalizedUid);
    }
  }

  return Array.from(new Set(uidValues));
}

function buildMessageSummary(message) {
  const deadlines = extractDeadlines(message.bodyText);

  return {
    uid: message.uid,
    messageId: message.messageId,
    subject: message.subject,
    from: message.from,
    receivedAt: message.receivedAt,
    summary: summarizeEmailContent({
      subject: message.subject,
      bodyText: message.bodyText,
    }),
    keyPoints: buildKeyPoints(message),
    actionItems: extractActionItems(message.bodyText),
    deadlines,
  };
}

export function buildSummarizeEmailHandler({ includeDebug = false, updatedBy = null, personalCacheTreeId = null } = {}) {
  return async function summarizeEmailHandler(args, agentContext = null) {
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
        throw new Error('A personal cache tree id is required to summarize an email.');
      }

      const targetUids = normalizeSummaryTargetUids(args);

      if (targetUids.length === 0) {
        throw new Error('At least one email uid is required to summarize email.');
      }

      let accountConfig = null;
      const summaries = [];

      for (const uid of targetUids) {
        emitStep('tool summarize_email checking cached message', {
          uid,
        });
        let message = await loadCachedEmailMessage({
          treeId: resolvedTreeId,
          provider: args.provider,
          uid,
        });

        if (!message) {
          if (!accountConfig) {
            emitStep('tool summarize_email loading account config');
            ({ accountConfig } = await loadEmailAccountConfig({
              treeId: resolvedTreeId,
              provider: args.provider,
            }));
          }
          emitStep('tool summarize_email fetching message', {
            uid,
          });
          message = await getImapMessageByUid(accountConfig, {
            uid,
            folder: args.folder,
          });
          await storeCachedEmailMessage({
            treeId: resolvedTreeId,
            provider: args.provider,
            uid,
            message,
            updatedBy: resolvedUpdatedBy,
          });
        }

        summaries.push(buildMessageSummary(message));
      }
      const output = summaries.length === 1
        ? summaries[0]
        : {
          summaries,
        };

      return buildEmailToolResult({
        toolName: SUMMARIZE_EMAIL_TOOL,
        toolResultType: 'email_summary',
        data: output,
        includeDebug,
        debug: includeDebug ? {
          uidCount: summaries.length,
          uids: summaries.map((summary) => summary.uid),
        } : null,
      });
    } catch (error) {
      throw attachDebugToError(error, includeDebug ? {
        provider: args?.provider ?? null,
        folder: args?.folder ?? null,
        uid: args?.uid ?? null,
        uids: Array.isArray(args?.uids) ? args.uids : null,
      } : null);
    }
  };
}