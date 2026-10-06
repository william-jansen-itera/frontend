import { appendDebugStep, attachDebugToError } from '@/server/utils/agent/agentDebug';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import { loadEmailAccountConfig } from '@/server/utils/agent/email/emailAccountConfigRepository';
import { loadCachedEmailMessage, storeCachedEmailMessage } from '@/server/utils/agent/email/emailCacheRepository';
import { classifyEmailContent } from '@/server/utils/agent/email/emailHeuristics';
import { getImapMessageByUid } from '@/server/utils/agent/email/emailTransport';

export const CLASSIFY_EMAIL_TOOL = 'classify_email';

export const classifyEmailToolDefinition = {
  type: 'function',
  name: CLASSIFY_EMAIL_TOOL,
  description: 'Read one email or a small list of emails by UID and return simple reply, action, deadline, and importance signals.',
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

function normalizeClassificationTargetUids(args) {
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

function buildMessageClassification(message) {
  const classification = classifyEmailContent({
    subject: message.subject,
    bodyText: message.bodyText,
  });

  return {
    uid: message.uid,
    messageId: message.messageId,
    subject: message.subject,
    ...classification,
  };
}

export function buildClassifyEmailHandler({ includeDebug = false, updatedBy = null, personalCacheTreeId = null } = {}) {
  return async function classifyEmailHandler(args, agentContext = null) {
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
        throw new Error('A personal cache tree id is required to classify an email.');
      }

      const targetUids = normalizeClassificationTargetUids(args);

      if (targetUids.length === 0) {
        throw new Error('At least one email uid is required to classify email.');
      }

      let accountConfig = null;
      const classifications = [];

      for (const uid of targetUids) {
        let message = await loadCachedEmailMessage({
          treeId: resolvedTreeId,
          provider: args.provider,
          uid,
        });

        if (!message) {
          if (!accountConfig) {
            emitStep('tool classify_email loading account config');
            ({ accountConfig } = await loadEmailAccountConfig({
              treeId: resolvedTreeId,
              provider: args.provider,
            }));
          }
          emitStep('tool classify_email fetching message', {
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

        classifications.push(buildMessageClassification(message));
      }
      const output = classifications.length === 1
        ? classifications[0]
        : {
          classifications,
        };

      return buildEmailToolResult({
        toolName: CLASSIFY_EMAIL_TOOL,
        toolResultType: 'email_classification',
        data: output,
        includeDebug,
        debug: includeDebug ? {
          uidCount: classifications.length,
          uids: classifications.map((classification) => classification.uid),
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