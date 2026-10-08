import { appendDebugStep, attachDebugToError } from '@/server/utils/agent/agentDebug';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import {
  loadCachedEmailMessage,
  loadLatestEmailRetrievalSnapshot,
  storeCachedEmailMessage,
} from '@/server/utils/agent/email/emailCacheRepository';
import { getProjectClient, getRequiredFoundryConfig } from '@/server/utils/foundryAgentClient';

export const ANALYZE_EMAIL_TOOL = 'analyze_email';

const MAX_MODEL_ANALYZE_MESSAGES = 10;
const MAX_MODEL_BODY_LENGTH = 12000;

const EMAIL_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    analyses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          uid: { type: 'string' },
          summary: { type: 'string' },
          keyPoints: {
            type: 'array',
            items: { type: 'string' },
          },
          replyItems: {
            type: 'array',
            items: { type: 'string' },
          },
          questionItems: {
            type: 'array',
            items: { type: 'string' },
          },
          actionItems: {
            type: 'array',
            items: { type: 'string' },
          },
          deadlineItems: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                deadlineAt: { type: ['string', 'null'] },
              },
              required: ['text', 'deadlineAt'],
              additionalProperties: false,
            },
          },
          classification: {
            type: 'object',
            properties: {
              replyExpected: { type: 'boolean' },
              questionAsked: { type: 'boolean' },
              otherActionRequired: { type: 'boolean' },
              deadlineMentioned: { type: 'boolean' },
              importance: { type: 'string', enum: ['low', 'normal', 'high'] },
              reason: {
                type: 'object',
                properties: {
                  replyExpected: { type: ['string', 'null'] },
                  questionAsked: { type: ['string', 'null'] },
                  otherActionRequired: { type: ['string', 'null'] },
                  deadlineMentioned: { type: ['string', 'null'] },
                  importance: { type: ['string', 'null'] },
                },
                required: ['replyExpected', 'questionAsked', 'otherActionRequired', 'deadlineMentioned', 'importance'],
                additionalProperties: false,
              },
            },
            required: ['replyExpected', 'questionAsked', 'otherActionRequired', 'deadlineMentioned', 'importance', 'reason'],
            additionalProperties: false,
          },
        },
        required: ['uid', 'summary', 'keyPoints', 'replyItems', 'questionItems', 'actionItems', 'deadlineItems', 'classification'],
        additionalProperties: false,
      },
    },
  },
  required: ['analyses'],
  additionalProperties: false,
};

export const analyzeEmailToolDefinition = {
  type: 'function',
  name: ANALYZE_EMAIL_TOOL,
  description:'Deep-read emails already returned by retrieve_emails. Pass every target in one uids array. The response always returns data.analyses, including for a single email. Do not call once per email.',
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
        description: 'Strings copied unchanged from data.emails[].uid in the latest retrieve_emails result. Example shape: data.emails[0].uid === "19613". Do not use the array index, data.resultCount, meta.resultCount, or any value not present in data.emails[].uid.',
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_MODEL_ANALYZE_MESSAGES,
      },
    },
    required: ['provider', 'folder', 'uids'],
    additionalProperties: false,
  },
};

function buildKeyPoints(message) {
  const senderLabel = message.from?.name && message.from?.address
    ? `${message.from.name} <${message.from.address}>`
    : message.from?.address || message.from?.name || null;

  return [
    message.subject ? `Subject: ${message.subject}` : null,
    senderLabel ? `From: ${senderLabel}` : null,
    message.preview ? `Preview: ${message.preview}` : null,
  ].filter(Boolean);
}

function normalizeAnalysisTargetUids(args) {
  const uidValues = [];

  for (const uid of Array.isArray(args?.uids) ? args.uids : []) {
    const normalizedUid = String(uid ?? '').trim();

    if (normalizedUid) {
      uidValues.push(normalizedUid);
    }
  }

  return Array.from(new Set(uidValues));
}

function buildMessageAnalysisInput(message) {
  return {
    uid: message.uid,
    subject: message.subject,
    from: message.from ?? null,
    to: message.to,
    receivedAt: message.receivedAt,
    preview: message.preview,
    bodyText: String(message.bodyText ?? '').slice(0, MAX_MODEL_BODY_LENGTH),
  };
}

function normalizeStringList(values, maxItems = 5) {
  return Array.from(
    new Map(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .map((value) => [value.toLowerCase(), value]),
    ).values(),
  ).slice(0, maxItems);
}

function normalizeDeadlineList(values) {
  return Array.from(
    new Map(
      (Array.isArray(values) ? values : [])
        .map((entry) => {
          const text = String(entry?.text ?? '').trim();

          if (!text) {
            return null;
          }

          const deadlineAt = typeof entry?.deadlineAt === 'string' && entry.deadlineAt.trim()
            ? entry.deadlineAt.trim()
            : null;

          return [`${text.toLowerCase()}::${deadlineAt ?? ''}`, {
            text,
            deadlineAt,
          }];
        })
        .filter(Boolean),
    ).values(),
  ).slice(0, 5);
}

function normalizePerClassReason(source) {
  if (source?.reason && typeof source.reason === 'object' && !Array.isArray(source.reason)) {
    return {
      replyExpected: typeof source.reason.replyExpected === 'string' && source.reason.replyExpected.trim()
        ? source.reason.replyExpected.trim()
        : null,
      questionAsked: typeof source.reason.questionAsked === 'string' && source.reason.questionAsked.trim()
        ? source.reason.questionAsked.trim()
        : null,
      otherActionRequired: typeof source.reason.otherActionRequired === 'string' && source.reason.otherActionRequired.trim()
        ? source.reason.otherActionRequired.trim()
        : null,
      deadlineMentioned: typeof source.reason.deadlineMentioned === 'string' && source.reason.deadlineMentioned.trim()
        ? source.reason.deadlineMentioned.trim()
        : null,
      importance: typeof source.reason.importance === 'string' && source.reason.importance.trim()
        ? source.reason.importance.trim()
        : null,
    };
  }

  const legacyReason = typeof source?.reason === 'string' && source.reason.trim()
    ? source.reason.trim()
    : null;

  return {
    replyExpected: source?.replyExpected ? legacyReason : null,
    questionAsked: source?.questionAsked ? legacyReason : null,
    otherActionRequired: source?.otherActionRequired ? legacyReason : null,
    deadlineMentioned: source?.deadlineMentioned ? legacyReason : null,
    importance: source?.importance && source.importance !== 'normal' ? legacyReason : null,
  };
}

function normalizeClassification(modelAnalysis) {
  const source = modelAnalysis?.classification && typeof modelAnalysis.classification === 'object'
    ? modelAnalysis.classification
    : modelAnalysis;
  const replyExpected = Boolean(source?.replyExpected);
  const questionAsked = Boolean(source?.questionAsked);
  const otherActionRequired = Boolean(source?.otherActionRequired);
  const deadlineMentioned = Boolean(source?.deadlineMentioned);
  const importance = ['low', 'normal', 'high'].includes(source?.importance)
    ? source.importance
    : 'normal';
  const reason = normalizePerClassReason({
    ...source,
    replyExpected,
    questionAsked,
    otherActionRequired,
    deadlineMentioned,
    importance,
  });

  return {
    replyExpected,
    questionAsked,
    otherActionRequired,
    deadlineMentioned,
    importance,
    reason,
  };
}

function parseModelAnalysisResponse(response) {
  const rawText = String(response?.output_text ?? '').trim();

  if (!rawText) {
    throw new Error('Analyze email model returned an empty response.');
  }

  let parsedResponse;

  try {
    parsedResponse = JSON.parse(rawText);
  } catch {
    throw new Error('Analyze email model response was not valid JSON.');
  }

  if (!Array.isArray(parsedResponse?.analyses)) {
    throw new Error('Analyze email model response did not include analyses.');
  }

  return parsedResponse.analyses;
}

async function analyzeMessagesWithModel(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      responseId: null,
      analyses: [],
    };
  }

  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const { modelDeploymentName } = getRequiredFoundryConfig();
  const response = await openAIClient.responses.create({
    model: modelDeploymentName,
    input: [
      {
        type: 'message',
        role: 'system',
        content: [
          'You deeply analyze email messages for an email assistant.',
          'Return one structured analysis entry for each provided email uid.',
          'Base the result only on the supplied email content and metadata.',
          'Write a short summary for each email as one paragraph with a few sentences.',
          'Return keyPoints as short factual bullets.',
          'Set replyExpected when the sender appears to expect a reply from the recipient.',
          'Return replyItems as the specific lines, phrases, or asks that support replyExpected.',
          'Set classification.questionAsked when the email explicitly asks a question.',
          'Return questionItems as the specific explicit questions from the email.',
          'Set classification.otherActionRequired when the email asks for a concrete non-reply action.',
          'Keep classification.replyExpected, classification.questionAsked, and classification.otherActionRequired independent from each other.',
          'Set classification.deadlineMentioned when the email mentions a due date, due time, or time expectation.',
          'Return actionItems as explicit asks or tasks stated or clearly implied in the email.',
          'Return deadlineItems only when the email mentions a due date or time expectation.',
          'For deadlineAt, return an ISO 8601 timestamp only when the email states an exact absolute date or date-time clearly enough to normalize safely; otherwise return null.',
          'Set classification.importance to high only for clearly urgent or important requests, low for clearly low-priority or FYI messages, otherwise normal.',
          'Provide classification.reason as an object with one short reason per class: replyExpected, questionAsked, otherActionRequired, deadlineMentioned, and importance.',
          'Use null for any classification.reason field that does not apply to the email.',
          'Return classification as an object with replyExpected, questionAsked, otherActionRequired, deadlineMentioned, importance, and reason.',
          'If an email has no reply items, question items, action items, or deadline items, return an empty array for that field.',
          'Do not invent missing details.',
          'Return JSON only.',
        ].join(' '),
      },
      {
        type: 'message',
        role: 'user',
        content: JSON.stringify({
          messages: messages.map(buildMessageAnalysisInput),
        }),
      },
    ],
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: 'email_analyses',
        strict: true,
        schema: EMAIL_ANALYSIS_SCHEMA,
      },
    },
  });

  return {
    responseId: response?.id ?? null,
    analyses: parseModelAnalysisResponse(response),
  };
}

function buildMessageAnalysis(message, modelAnalysis) {
  const resolvedModelAnalysis = modelAnalysis && typeof modelAnalysis === 'object' ? modelAnalysis : null;
  const classification = normalizeClassification(resolvedModelAnalysis);

  return {
    uid: message.uid,
    messageId: message.messageId,
    subject: message.subject,
    from: message.from ?? null,
    receivedAt: message.receivedAt,
    summary: String(resolvedModelAnalysis?.summary ?? '').replace(/\s+/g, ' ').trim(),
    keyPoints: normalizeStringList(resolvedModelAnalysis?.keyPoints).length > 0
      ? normalizeStringList(resolvedModelAnalysis?.keyPoints)
      : buildKeyPoints(message),
    replyItems: normalizeStringList(resolvedModelAnalysis?.replyItems),
    questionItems: normalizeStringList(resolvedModelAnalysis?.questionItems),
    actionItems: normalizeStringList(resolvedModelAnalysis?.actionItems),
    deadlineItems: normalizeDeadlineList(resolvedModelAnalysis?.deadlineItems),
    classification,
  };
}

export function buildAnalyzeEmailHandler({ includeDebug = false, updatedBy = null, personalCacheTreeId = null } = {}) {
  return async function analyzeEmailHandler(args, agentContext = null) {
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
        throw new Error('A personal cache tree id is required to analyze an email.');
      }

      const targetUids = normalizeAnalysisTargetUids(args);

      if (targetUids.length === 0) {
        throw new Error('At least one email uid is required to analyze email.');
      }

      const messages = [];
      const normalizedFolder = String(args.folder ?? 'INBOX').trim() || 'INBOX';
      let snapshot = null;
      let snapshotMessages = null;

      const loadSnapshotMessages = async () => {
        if (snapshotMessages !== null) {
          return snapshotMessages;
        }

        snapshot = await loadLatestEmailRetrievalSnapshot({
          treeId: resolvedTreeId,
          provider: args.provider,
          folder: normalizedFolder,
        });
        snapshotMessages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
        return snapshotMessages;
      };

      for (const uid of targetUids) {
        emitStep('tool analyze_email checking cached message', {
          uid,
        });
        let message = await loadCachedEmailMessage({
          treeId: resolvedTreeId,
          provider: args.provider,
          uid,
        });

        if (!message) {
          emitStep('tool analyze_email checking retrieval snapshot', {
            uid,
            folder: normalizedFolder,
          });
          const resolvedSnapshotMessages = await loadSnapshotMessages();

          message = Array.isArray(resolvedSnapshotMessages)
            ? resolvedSnapshotMessages.find((entry) => String(entry?.uid ?? '').trim() === uid) ?? null
            : null;

          if (message) {
            emitStep('tool analyze_email found message in retrieval snapshot', {
              uid,
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
          } else if (Array.isArray(resolvedSnapshotMessages)) {
            throw new Error(
              `Wrong message uid was provided: ${uid}. The requested email does not match any message in the latest retrieval snapshot for folder ${normalizedFolder}.`,
            );
          }
        }

        if (!message) {
          throw new Error(
            `Email uid ${uid} is not available in the current cache for folder ${normalizedFolder}. Retrieve emails for that folder first, then analyze one of the returned UIDs.`,
          );
        }

        messages.push(message);
      }

      emitStep('tool analyze_email requesting model analyses', {
        uidCount: messages.length,
      });
      const { responseId, analyses: modelAnalyses } = await analyzeMessagesWithModel(messages);
      const modelAnalysisByUid = new Map(
        modelAnalyses
          .map((entry) => [String(entry?.uid ?? '').trim(), entry])
          .filter(([uid]) => Boolean(uid)),
      );
      const analyses = messages.map((message) => {
        const modelAnalysis = modelAnalysisByUid.get(String(message.uid ?? '').trim());

        if (!modelAnalysis) {
          throw new Error(`Analyze email model did not return an analysis for uid ${message.uid}.`);
        }

        return buildMessageAnalysis(message, modelAnalysis);
      });
      return buildEmailToolResult({
        toolName: ANALYZE_EMAIL_TOOL,
        toolResultType: 'email_analysis',
        data: {
          analyses,
        },
        includeDebug,
        debug: includeDebug ? {
          modelResponseId: responseId,
          uidCount: analyses.length,
          uids: analyses.map((analysis) => analysis.uid),
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