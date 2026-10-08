import { appendDebugStep, attachDebugToError } from '@/server/utils/agent/agentDebug';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import { loadEmailAccountConfig } from '@/server/utils/agent/email/emailAccountConfigRepository';
import {
  isEmailRetrievalSnapshotFresh,
  loadLatestEmailRetrievalSnapshot,
  storeLatestEmailRetrievalSnapshot,
} from '@/server/utils/agent/email/emailCacheRepository';
import {
  buildCachedEmailHeuristics,
} from '@/server/utils/agent/email/emailHeuristics';
import {
  REFRESH_RETRIEVAL_SCAN_LIMIT,
  computeRetrievalScanLimit,
  normalizeRetrievalLimit,
  retrieveEmailsFromImap,
} from '@/server/utils/agent/email/emailTransport';

export const RETRIEVE_EMAILS_TOOL = 'retrieve_emails';

function normalizeContainsValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeAnyTextQueries(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(new Set(
    values
      .map((value) => normalizeContainsValue(value))
      .filter(Boolean),
  ));
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
  const otherActionRequiredOnly = Boolean(filters.otherActionRequiredOnly);
  const deadlineMentionedOnly = Boolean(filters.deadlineMentionedOnly);

  return {
    includeHeuristics,
    replyExpectedOnly,
    otherActionRequiredOnly,
    deadlineMentionedOnly,
    needsClassification: includeHeuristics || replyExpectedOnly || otherActionRequiredOnly,
    needsReplyItems: includeHeuristics || replyExpectedOnly,
    needsActionItems: includeHeuristics || otherActionRequiredOnly,
    needsDeadlineItems: includeHeuristics || deadlineMentionedOnly,
  };
}

function evaluateMessageHeuristics(message, heuristicPlan) {
  const cachedHeuristics = message?.heuristicCache && typeof message.heuristicCache === 'object'
    ? message.heuristicCache
    : buildCachedEmailHeuristics({
      subject: String(message?.subject ?? ''),
      bodyText: String(message?.bodyText ?? ''),
    });
  const heuristics = {};

  if (heuristicPlan.needsClassification) {
    heuristics.classification = cachedHeuristics.classification ?? null;
  }

  if (heuristicPlan.needsReplyItems) {
    heuristics.replyItems = Array.isArray(cachedHeuristics.replyItems)
      ? cachedHeuristics.replyItems
      : Array.isArray(cachedHeuristics.replyMatches)
        ? cachedHeuristics.replyMatches
        : [];
  }

  if (heuristicPlan.needsActionItems) {
    heuristics.actionItems = Array.isArray(cachedHeuristics.actionItems) ? cachedHeuristics.actionItems : [];
  }

  if (heuristicPlan.needsDeadlineItems) {
    heuristics.deadlineItems = Array.isArray(cachedHeuristics.deadlineItems)
      ? cachedHeuristics.deadlineItems
      : Array.isArray(cachedHeuristics.deadlines)
        ? cachedHeuristics.deadlines
        : [];
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
  const anyTextQueries = normalizeAnyTextQueries(filters.anyTextQueries);
  const fromValue = normalizeContainsValue([message?.from?.name, message?.from?.address].filter(Boolean).join(' '));
  const subjectValue = normalizeContainsValue(message?.subject);
  const previewValue = normalizeContainsValue(message?.preview);
  const bodyValue = normalizeContainsValue(message?.bodyText);
  const searchableValues = [subjectValue, previewValue, bodyValue];

  if (fromContains && !fromValue.includes(fromContains)) {
    return false;
  }

  if (subjectContains && !subjectValue.includes(subjectContains)) {
    return false;
  }

  if (textQuery && !searchableValues.some((value) => value.includes(textQuery))) {
    return false;
  }

  if (anyTextQueries.length > 0 && !anyTextQueries.some((query) => searchableValues.some((value) => value.includes(query)))) {
    return false;
  }

  if (filters.replyExpectedOnly && !heuristics?.classification?.replyExpected) {
    return false;
  }

  if (filters.otherActionRequiredOnly && !heuristics?.classification?.otherActionRequired) {
    return false;
  }

  if (filters.deadlineMentionedOnly && !Array.isArray(heuristics?.deadlineItems)) {
    return false;
  }

  if (filters.deadlineMentionedOnly && heuristics.deadlineItems.length === 0) {
    return false;
  }

  return true;
}

function buildReturnedMessage(message, heuristics, heuristicPlan) {
  const { bodyText, heuristicCache, ...baseMessage } = message;
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];

  const returnedMessage = {
    ...baseMessage,
    attachmentCount: attachments.length,
    attachmentFileNames: attachments.map((attachment) => String(attachment?.fileName ?? '').trim()).filter(Boolean),
  };

  if (!heuristicPlan.includeHeuristics && !heuristicPlan.replyExpectedOnly && !heuristicPlan.otherActionRequiredOnly && !heuristicPlan.deadlineMentionedOnly) {
    return returnedMessage;
  }

  if (heuristicPlan.needsClassification && heuristics?.classification) {
    returnedMessage.heuristicClassification = heuristics.classification;
  }

  if (heuristicPlan.needsReplyItems && Array.isArray(heuristics?.replyItems)) {
    returnedMessage.replyItemCount = heuristics.replyItems.length;
    returnedMessage.replyItemsPreview = heuristicPlan.includeHeuristics
      ? heuristics.replyItems.slice(0, 2)
      : [];
  }

  if (heuristicPlan.needsActionItems && Array.isArray(heuristics?.actionItems)) {
    returnedMessage.actionItemCount = heuristics.actionItems.length;
    returnedMessage.actionItemsPreview = heuristicPlan.includeHeuristics
      ? heuristics.actionItems.slice(0, 2)
      : [];
  }

  if (heuristicPlan.needsDeadlineItems && Array.isArray(heuristics?.deadlineItems)) {
    returnedMessage.deadlineCount = heuristics.deadlineItems.length;
    returnedMessage.deadlineItems = heuristics.deadlineItems;
  }

  return returnedMessage;
}

function applyRetrievalFilters(messages, filters) {
  const heuristicPlan = buildHeuristicPlan(filters);
  const normalizedLimit = normalizeRetrievalLimit(filters.limit);
  const matchedMessages = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const heuristics = (heuristicPlan.needsClassification || heuristicPlan.needsReplyItems || heuristicPlan.needsActionItems || heuristicPlan.needsDeadlineItems)
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

export const retrieveEmailsToolDefinition = {
  type: 'function',
  name: RETRIEVE_EMAILS_TOOL,
  description: 'Retrieve a bounded set of emails from a folder, usually from the latest cached retrieval snapshot and optionally from a fresh IMAP refresh when forceRefresh is true or the snapshot is stale. Apply local filters to the cached message subject, preview, and normalized body content. Supports exact textQuery matching and agent-composed OR-style anyTextQueries keyword matching for broader topical retrieval.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      provider: { type: 'string', description: 'Email account provider key, such as hover. This selects the configured mailbox account, not the sender of the email.' },
      folder: { type: 'string', description: 'Mailbox folder to read from, such as INBOX.' },
      forceRefresh: { type: 'boolean', description: 'When true, bypass any fresh cached folder snapshot and fetch the latest mailbox window from IMAP before filtering. Use this when the user explicitly wants the latest or newest emails.' },
      includeHeuristics: { type: 'boolean', description: 'When true, include heuristic classification, action, and deadline signals on returned messages for list-level triage.' },
      unreadOnly: { type: 'boolean', description: 'When true, only return emails that do not currently have the IMAP \\Seen flag.' },
      flaggedOnly: { type: 'boolean', description: 'When true, only return emails that currently have the IMAP \\Flagged flag.' },
      replyExpectedOnly: { type: 'boolean', description: 'When true, only return emails whose content heuristically suggests that a reply is expected.' },
      otherActionRequiredOnly: { type: 'boolean', description: 'When true, only return emails whose content heuristically suggests that some non-reply action is required.' },
      deadlineMentionedOnly: { type: 'boolean', description: 'When true, only return emails whose content heuristically mentions a deadline or due time.' },
      fromContains: { type: ['string', 'null'], description: 'Optional case-insensitive substring filter applied to the sender display name or email address.' },
      subjectContains: { type: ['string', 'null'], description: 'Optional case-insensitive substring filter applied to the message subject only.' },
      textQuery: { type: ['string', 'null'], description: 'Optional free-text topic or keyword filter, such as football, invoice, deadline, or project alpha. This is matched locally against the fetched message subject, preview, and normalized body text from a bounded recent IMAP result set.' },
      anyTextQueries: {
        type: ['array', 'null'],
        description: 'Optional agent-composed OR-style keyword list for broad or fuzzy topical retrieval. A message matches when any keyword appears in the fetched message subject, preview, or normalized body text. For broad topics, prefer a recall-oriented list built in three steps: obvious synonyms first, obvious related terms second, and obvious subcategories third, usually ending up with about 8 to 12 total terms.',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 12,
      },
      since: { type: ['string', 'null'], description: 'Optional inclusive lower date bound as an ISO date or datetime string.' },
      before: { type: ['string', 'null'], description: 'Optional inclusive upper date bound as an ISO date or datetime string.' },
      limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum number of matching emails to return after filtering. Keep this small because matching is done against a bounded recent IMAP fetch window.' },
    },
    required: ['provider', 'folder', 'forceRefresh', 'includeHeuristics', 'unreadOnly', 'flaggedOnly', 'replyExpectedOnly', 'otherActionRequiredOnly', 'deadlineMentionedOnly', 'fromContains', 'subjectContains', 'textQuery', 'anyTextQueries', 'since', 'before', 'limit'],
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
        otherActionRequiredOnly: Boolean(args.otherActionRequiredOnly),
        deadlineMentionedOnly: Boolean(args.deadlineMentionedOnly),
        fromContains: args.fromContains ?? null,
        subjectContains: args.subjectContains ?? null,
        textQuery: args.textQuery ?? null,
        anyTextQueries: normalizeAnyTextQueries(args.anyTextQueries),
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
          snapshotWindowSize: REFRESH_RETRIEVAL_SCAN_LIMIT,
        });
        const retrievalResult = await retrieveEmailsFromImap(accountConfig, {
          folder: normalizedFolder,
          limit: 25,
          scanLimit: REFRESH_RETRIEVAL_SCAN_LIMIT,
          returnAllScanned: true,
        });
        cachedSnapshot = await storeLatestEmailRetrievalSnapshot({
          treeId: resolvedTreeId,
          provider: args.provider,
          folder: normalizedFolder,
          messages: retrievalResult.messages,
          updatedBy: resolvedUpdatedBy,
          sourceWindowSize: retrievalResult.scanLimit ?? REFRESH_RETRIEVAL_SCAN_LIMIT,
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
          emails: filteredMessages,
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