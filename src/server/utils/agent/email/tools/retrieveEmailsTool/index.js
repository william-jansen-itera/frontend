import { appendDebugStep, attachDebugToError } from '@/server/utils/agent/agentDebug';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import { loadEmailAccountConfig } from '@/server/utils/agent/email/emailAccountConfigRepository';
import {
  isEmailRetrievalSnapshotFresh,
  loadLatestEmailRetrievalSnapshot,
  storeLatestEmailRetrievalSnapshot,
} from '@/server/utils/agent/email/emailCacheRepository';
import {
  classifyEmailContent,
  extractActionItems,
  extractDeadlines,
  summarizeEmailContent,
} from '@/server/utils/agent/email/emailHeuristics';
import {
  computeRetrievalScanLimit,
  normalizeRetrievalLimit,
  retrieveEmailsFromImap,
} from '@/server/utils/agent/email/emailTransport';

export const RETRIEVE_EMAILS_TOOL = 'retrieve_emails';

function normalizeContainsValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

function matchesDateBounds(message, { since = null, before = null } = {}) {
  const receivedAtValue = String(message?.receivedAt ?? '').trim();

  if (!receivedAtValue) {
    return true;
  }

  const messageTime = new Date(receivedAtValue).getTime();

  if (!Number.isFinite(messageTime)) {
    return true;
  }

  if (since) {
    const sinceTime = new Date(since).getTime();

    if (Number.isFinite(sinceTime) && messageTime < sinceTime) {
      return false;
    }
  }

  if (before) {
    const beforeTime = new Date(before).getTime();

    if (Number.isFinite(beforeTime) && messageTime > beforeTime) {
      return false;
    }
  }

  return true;
}

function buildHeuristicPlan(filters) {
  const includeHeuristics = Boolean(filters.includeHeuristics);
  const replyExpectedOnly = Boolean(filters.replyExpectedOnly);
  const actionRequiredOnly = Boolean(filters.actionRequiredOnly);
  const deadlineMentionedOnly = Boolean(filters.deadlineMentionedOnly);

  return {
    includeHeuristics,
    replyExpectedOnly,
    actionRequiredOnly,
    deadlineMentionedOnly,
    needsClassification: includeHeuristics || replyExpectedOnly || actionRequiredOnly,
    needsActionItems: includeHeuristics || actionRequiredOnly,
    needsDeadlines: includeHeuristics || deadlineMentionedOnly,
    needsSummary: includeHeuristics,
  };
}

function evaluateMessageHeuristics(message, heuristicPlan) {
  const subject = String(message?.subject ?? '');
  const bodyText = String(message?.bodyText ?? '');
  const heuristics = {};

  if (heuristicPlan.needsClassification) {
    heuristics.classification = classifyEmailContent({
      subject,
      bodyText,
    });
  }

  if (heuristicPlan.needsActionItems) {
    heuristics.actionItems = extractActionItems(bodyText);
  }

  if (heuristicPlan.needsDeadlines) {
    heuristics.deadlines = extractDeadlines(bodyText);
  }

  if (heuristicPlan.needsSummary) {
    heuristics.summary = summarizeEmailContent({
      subject,
      bodyText,
    });
  }

  return heuristics;
}

function matchesLocalFilters(message, filters, heuristics = null) {
  const flags = Array.isArray(message?.flags) ? message.flags : [];

  if (filters.unreadOnly && flags.includes('\\Seen')) {
    return false;
  }

  if (filters.flaggedOnly && !flags.includes('\\Flagged')) {
    return false;
  }

  if (!matchesDateBounds(message, filters)) {
    return false;
  }

  const fromContains = normalizeContainsValue(filters.fromContains);
  const subjectContains = normalizeContainsValue(filters.subjectContains);
  const textQuery = normalizeContainsValue(filters.textQuery);
  const fromValue = normalizeContainsValue(message?.from);
  const subjectValue = normalizeContainsValue(message?.subject);
  const previewValue = normalizeContainsValue(message?.preview);
  const bodyValue = normalizeContainsValue(message?.bodyText);

  if (fromContains && !fromValue.includes(fromContains)) {
    return false;
  }

  if (subjectContains && !subjectValue.includes(subjectContains)) {
    return false;
  }

  if (textQuery && !subjectValue.includes(textQuery) && !previewValue.includes(textQuery) && !bodyValue.includes(textQuery)) {
    return false;
  }

  if (filters.replyExpectedOnly && !heuristics?.classification?.replyExpected) {
    return false;
  }

  if (filters.actionRequiredOnly && !heuristics?.classification?.actionRequired) {
    return false;
  }

  if (filters.deadlineMentionedOnly && !Array.isArray(heuristics?.deadlines)) {
    return false;
  }

  if (filters.deadlineMentionedOnly && heuristics.deadlines.length === 0) {
    return false;
  }

  return true;
}

function buildReturnedMessage(message, heuristics, heuristicPlan) {
  const { bodyText, ...baseMessage } = message;

  if (!heuristicPlan.includeHeuristics && !heuristicPlan.replyExpectedOnly && !heuristicPlan.actionRequiredOnly && !heuristicPlan.deadlineMentionedOnly) {
    return baseMessage;
  }

  const returnedMessage = { ...baseMessage };

  if (heuristicPlan.needsSummary && heuristics?.summary) {
    returnedMessage.heuristicSummary = heuristics.summary;
  }

  if (heuristicPlan.needsClassification && heuristics?.classification) {
    returnedMessage.heuristicClassification = heuristics.classification;
  }

  if (heuristicPlan.needsActionItems && Array.isArray(heuristics?.actionItems)) {
    returnedMessage.actionItemCount = heuristics.actionItems.length;
    returnedMessage.actionItemsPreview = heuristicPlan.includeHeuristics
      ? heuristics.actionItems.slice(0, 2)
      : [];
  }

  if (heuristicPlan.needsDeadlines && Array.isArray(heuristics?.deadlines)) {
    returnedMessage.deadlineCount = heuristics.deadlines.length;
    returnedMessage.deadlines = heuristics.deadlines;
  }

  return returnedMessage;
}

function applyRetrievalFilters(messages, filters) {
  const heuristicPlan = buildHeuristicPlan(filters);
  const normalizedLimit = normalizeRetrievalLimit(filters.limit);
  const matchedMessages = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const heuristics = (heuristicPlan.needsClassification || heuristicPlan.needsActionItems || heuristicPlan.needsDeadlines || heuristicPlan.needsSummary)
      ? evaluateMessageHeuristics(message, heuristicPlan)
      : null;

    if (!matchesLocalFilters(message, filters, heuristics)) {
      continue;
    }

    matchedMessages.push(buildReturnedMessage(message, heuristics, heuristicPlan));

    if (matchedMessages.length >= normalizedLimit) {
      break;
    }
  }

  return matchedMessages;
}

function buildRetrievedMessageInsight(message) {
  const subject = String(message?.subject ?? '');
  const bodyText = String(message?.bodyText ?? '');
  const classification = classifyEmailContent({
    subject,
    bodyText,
  });
  const actionItems = extractActionItems(bodyText);
  const deadlines = extractDeadlines(bodyText);

  return {
    heuristicSummary: summarizeEmailContent({
      subject,
      bodyText,
    }),
    heuristicClassification: classification,
    actionItemCount: actionItems.length,
    actionItemsPreview: actionItems.slice(0, 2),
    deadlineCount: deadlines.length,
    deadlines,
  };
}

export const retrieveEmailsToolDefinition = {
  type: 'function',
  name: RETRIEVE_EMAILS_TOOL,
  description: 'Retrieve a bounded recent set of emails from the configured IMAP mailbox and cache the latest folder snapshot for follow-up email tools. Text filters are applied locally against the cached message subject, preview, and normalized body content, which is suitable for general-purpose IMAP providers such as Hover.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      provider: { type: 'string', description: 'Email provider key, such as hover.' },
      folder: { type: 'string', description: 'Mailbox folder to read from, such as INBOX.' },
      forceRefresh: { type: 'boolean', description: 'When true, bypass any fresh cached folder snapshot and fetch the latest mailbox window from IMAP before filtering. Use this when the user explicitly wants the latest or newest emails.' },
      includeHeuristics: { type: 'boolean', description: 'When true, include heuristic summary and classification fields on returned messages for list-level triage.' },
      unreadOnly: { type: 'boolean', description: 'When true, only return emails that do not currently have the IMAP \\Seen flag.' },
      flaggedOnly: { type: 'boolean', description: 'When true, only return emails that currently have the IMAP \\Flagged flag.' },
      replyExpectedOnly: { type: 'boolean', description: 'When true, only return emails whose content heuristically suggests that a reply is expected.' },
      actionRequiredOnly: { type: 'boolean', description: 'When true, only return emails whose content heuristically suggests that an action or reply is required.' },
      deadlineMentionedOnly: { type: 'boolean', description: 'When true, only return emails whose content heuristically mentions a deadline or due time.' },
      fromContains: { type: ['string', 'null'], description: 'Optional case-insensitive substring filter applied to the sender email address.' },
      subjectContains: { type: ['string', 'null'], description: 'Optional case-insensitive substring filter applied to the message subject only.' },
      textQuery: { type: ['string', 'null'], description: 'Optional free-text topic or keyword filter, such as football, invoice, deadline, or project alpha. This is matched locally against the fetched message subject, preview, and normalized body text from a bounded recent IMAP result set.' },
      since: { type: ['string', 'null'], description: 'Optional inclusive lower date bound as an ISO date or datetime string.' },
      before: { type: ['string', 'null'], description: 'Optional inclusive upper date bound as an ISO date or datetime string.' },
      limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum number of matching emails to return after filtering. Keep this small because matching is done against a bounded recent IMAP fetch window.' },
    },
    required: ['provider', 'folder', 'forceRefresh', 'unreadOnly', 'flaggedOnly', 'fromContains', 'subjectContains', 'textQuery', 'since', 'before', 'limit'],
    additionalProperties: false,
  },
};

export function buildRetrieveEmailsHandler({ includeDebug = false, updatedBy = null, personalCacheTreeId = null } = {}) {
  return async function retrieveEmailsHandler(args, agentContext = null) {
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
        throw new Error('A personal cache tree id is required to retrieve emails.');
      }

      emitStep('tool retrieve_emails loading account config');
      const { accountConfig } = await loadEmailAccountConfig({
        treeId: resolvedTreeId,
        provider: args.provider,
      });
      const normalizedFolder = String(args.folder ?? 'INBOX').trim() || 'INBOX';
      const normalizedQuery = {
        folder: normalizedFolder,
        forceRefresh: Boolean(args.forceRefresh),
        includeHeuristics: Boolean(args.includeHeuristics),
        unreadOnly: Boolean(args.unreadOnly),
        flaggedOnly: Boolean(args.flaggedOnly),
        replyExpectedOnly: Boolean(args.replyExpectedOnly),
        actionRequiredOnly: Boolean(args.actionRequiredOnly),
        deadlineMentionedOnly: Boolean(args.deadlineMentionedOnly),
        fromContains: args.fromContains ?? null,
        subjectContains: args.subjectContains ?? null,
        textQuery: args.textQuery ?? null,
        since: args.since ?? null,
        before: args.before ?? null,
        limit: normalizeRetrievalLimit(args.limit),
      };
      let cachedSnapshot = await loadLatestEmailRetrievalSnapshot({
        treeId: resolvedTreeId,
        provider: args.provider,
        folder: normalizedFolder,
      });
      let snapshotMessages = Array.isArray(cachedSnapshot?.messages) ? cachedSnapshot.messages : null;
      let snapshotSource = 'cache';

      if (normalizedQuery.forceRefresh || !snapshotMessages || !isEmailRetrievalSnapshotFresh(cachedSnapshot)) {
        emitStep('tool retrieve_emails loading messages', {
          folder: normalizedFolder,
          forceRefresh: normalizedQuery.forceRefresh,
          snapshotWindowSize: computeRetrievalScanLimit(25),
        });
        const retrievalResult = await retrieveEmailsFromImap(accountConfig, {
          folder: normalizedFolder,
          limit: 25,
          returnAllScanned: true,
        });
        cachedSnapshot = await storeLatestEmailRetrievalSnapshot({
          treeId: resolvedTreeId,
          provider: args.provider,
          folder: normalizedFolder,
          messages: retrievalResult.messages,
          updatedBy: resolvedUpdatedBy,
          sourceWindowSize: retrievalResult.scanLimit ?? computeRetrievalScanLimit(25),
        });
        snapshotMessages = cachedSnapshot.messages;
        snapshotSource = normalizedQuery.forceRefresh ? 'imap_forced_refresh' : 'imap';
      } else {
        emitStep('tool retrieve_emails using cached retrieval snapshot', {
          folder: normalizedFolder,
          cachedAt: cachedSnapshot.createdAt,
        });
      }

      const filteredMessages = applyRetrievalFilters(snapshotMessages, normalizedQuery);

      return buildEmailToolResult({
        toolName: RETRIEVE_EMAILS_TOOL,
        toolResultType: 'email_retrieval',
        data: {
          accountLabel: accountConfig.label,
          provider: accountConfig.provider,
          folder: normalizedFolder,
          query: normalizedQuery,
          datasetKey: cachedSnapshot?.datasetKey ?? null,
          lastCheckedAt: cachedSnapshot?.createdAt ?? null,
          retrievalSource: snapshotSource,
          usedCachedSnapshot: snapshotSource === 'cache',
          canForceRefresh: true,
          refreshSuggested: snapshotSource === 'cache' && !normalizedQuery.forceRefresh,
          messages: filteredMessages.map(({ bodyText, ...message }) => ({
            ...message,
            ...buildRetrievedMessageInsight({
              ...message,
              bodyText,
            }),
          })),
          resultCount: filteredMessages.length,
        },
        includeDebug,
        debug: includeDebug ? {
          datasetKey: cachedSnapshot?.datasetKey ?? null,
          resultCount: filteredMessages.length,
          forceRefresh: normalizedQuery.forceRefresh,
          snapshotSource,
          snapshotMessageCount: Array.isArray(snapshotMessages) ? snapshotMessages.length : 0,
        } : null,
      });
    } catch (error) {
      throw attachDebugToError(error, includeDebug ? {
        provider: args?.provider ?? null,
        folder: args?.folder ?? null,
        limit: args?.limit ?? null,
      } : null);
    }
  };
}