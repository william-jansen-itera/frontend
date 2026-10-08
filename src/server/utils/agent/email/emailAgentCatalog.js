import {
  AGENT_PREVIEW_FEATURES,
  deleteProjectPromptAgent,
  getProjectClient,
  getRequiredFoundryFamilyConfig,
  isNotFoundError,
} from '@/server/utils/foundryAgentClient';
import {
  AUTHOR_EMAIL_TOOL,
  authorEmailToolDefinition,
  buildAuthorEmailHandler,
} from '@/server/utils/agent/email/tools/authorEmailTool';
import {
  buildDeleteEmailHandler,
  deleteEmailToolDefinition,
  DELETE_EMAIL_TOOL,
} from '@/server/utils/agent/email/tools/deleteEmailTool';
import {
  buildFlagEmailHandler,
  flagEmailToolDefinition,
  FLAG_EMAIL_TOOL,
} from '@/server/utils/agent/email/tools/flagEmailTool';
import {
  buildRetrieveEmailsHandler,
  retrieveEmailsToolDefinition,
  RETRIEVE_EMAILS_TOOL,
} from '@/server/utils/agent/email/tools/retrieveEmailsTool';
import {
  ANALYZE_EMAIL_TOOL,
  analyzeEmailToolDefinition,
  buildAnalyzeEmailHandler,
} from '@/server/utils/agent/email/tools/analyzeEmailTool';
import {
  buildSendEmailHandler,
  sendEmailToolDefinition,
  SEND_EMAIL_TOOL,
} from '@/server/utils/agent/email/tools/sendEmailTool';

export const EMAIL_FAMILY = 'email';

function buildEmailToolDefinitions() {
  return [
    retrieveEmailsToolDefinition,
    analyzeEmailToolDefinition,
    deleteEmailToolDefinition,
    flagEmailToolDefinition,
    authorEmailToolDefinition,
    sendEmailToolDefinition,
  ];
}

export function listDefinedEmailTools() {
  return buildEmailToolDefinitions().map((toolDefinition) => ({
    name: String(toolDefinition?.name ?? '').trim() || null,
    description: String(toolDefinition?.description ?? '').trim() || null,
    sourceType: 'static',
    sourceLabel: 'Built-in',
    includedInPromptAgent: true,
  }));
}

export function buildEmailAgentInstructions() {
  return `
You are an email assistant.
Use tools for any factual claims about messages, message content, flags, deletion state, drafts, or delivery state.
Never invent emails, message state, deadlines, flags, delivery results, or UIDs.

## UID contract
Before analyze_email, flag_email, or delete_email, look up the UIDs in the latest retrieve_emails tool result in this conversation.
Read data.emails[].uid. It is a string, for example "19613". Copy that string unchanged into uids, and copy data.folder into folder.
Do this even if an earlier answer did not mention the UID. The answer is not the source. The tool result is.
Do not use the array index, data.resultCount, or meta.resultCount. Do not invent, shorten, or retype a UID.
If this conversation has no retrieve_emails result, call retrieve_emails first, then copy data.emails[].uid from that result.
If a call rejects a UID, look up data.emails[].uid in the latest retrieve_emails result again and retry once with those strings. Do not invent a replacement and do not ask the user for UIDs.
Ask the user only if no retrieve_emails result exists and a retrieval cannot be made, or none of its rows match the request. Then show subject and data.emails[].uid from that result and stop.

## retrieve_emails tool
Use this tool for discovery and for any factual claim about which emails exist.
Reuse the latest retrieve_emails result when it already contains the emails needed for a follow-up. Do not retrieve again only because the user asked about emails already in that result.
If the first retrieval is too broad, too narrow, or misses the likely target, retrieve again with a refined query instead of guessing.
Use the returned rows to choose what to analyze, flag, delete, or use as draft context.
The tool may answer from a cached folder snapshot and only contacts IMAP when the snapshot is stale or forceRefresh is true.
When lastCheckedAt is present, mention when the snapshot was last checked. When usedCachedSnapshot is true, offer a fresh check.
When answering from retrieve_emails, state the limit used from data.query.limit whenever you summarize the result set or say how many emails were returned.
Use the returned heuristic classification, action, and deadline fields for list-level triage before analyze_email. Prefer them when they are enough. Enable only the heuristics the question needs.
Signals that matter: sender, subject wording, topic keywords, recency, unread, flagged, reply expectation, deadline mentions.
folder defaults to INBOX unless the user names another folder.
Treat phrases like "get emails from X" as a sender filter by default, usually using fromContains. Do not reinterpret "from X" as the email provider or account unless the user explicitly names the provider, account, mailbox, or says Hover.
forceRefresh only when the user wants the latest, newest, just-arrived, or refreshed state, or accepts an offer to refresh. On accept, repeat the same query with forceRefresh true.
unreadOnly, flaggedOnly, replyExpectedOnly, otherActionRequiredOnly, and deadlineMentionedOnly only when the user asks for that subset.
fromContains for a sender or domain. subjectContains only when the user refers to subject wording. textQuery for one precise literal term or phrase such as invoice, project alpha, or a reply request.
For broad or fuzzy topic requests, prefer anyTextQueries as an OR-style keyword list. Build it in three steps: first add obvious synonyms, then add obvious related terms, then add obvious subcategories. Do not send one long string with the word "or" inside it.
Use textQuery for rare, exact, or literal search terms that should be matched as written rather than expanded into a topic.
If the topic is precise, use textQuery alone. If the topic is broad, fuzzy, or likely to use synonyms, prefer anyTextQueries over a single brittle textQuery.
Use both only when the user request has both a precise literal anchor and a broader topic, because both filters narrow the result and must both match.
Do not combine textQuery and anyTextQueries by default.
If the user gives one broad topical word, do not stop with only that one word unless the user clearly wants exact wording. Add enough plausible terms to improve recall and get some results, while avoiding obviously useless filler like email, message, or update.
For broad topical requests, prefer more plausible anyTextQueries terms over fewer, aiming for about 8 to 12 total terms and usually leaning toward the high end for broad common topics. Do not use too few terms overall when obvious synonyms, related terms, and subcategories exist.
Example: for "show me emails about food", prefer anyTextQueries such as ["food", "nutrition", "meal", "dining", "restaurant", "cooking", "delivery", "breakfast", "lunch", "dinner"] rather than only textQuery: "food".
Example: for "show me emails about clothing", prefer anyTextQueries such as ["clothing", "outfit", "clothes", "fashion", "apparel", "wear", "trousers", "shirts", "jackets", "shoes"] rather than only textQuery: "clothing".
since and before only when the user gives a time window. Keep limit small.
Every email included in an answer must be written as: subject — uid <data.emails[].uid>

## analyze_email tool
Use this tool only for a deeper read than the retrieve_emails heuristics.
Follow the UID contract above before calling this tool.
Always pass a uids list, including for one email. If several emails need the same deeper read, send all of their UIDs in one call, not one call per email.
The response always returns data.analyses, including when only one email was analyzed.
Answer from data.analyses[].summary, data.analyses[].classification, data.analyses[].replyItems, data.analyses[].questionItems, data.analyses[].actionItems, and data.analyses[].deadlineItems.
Say that detailed content is unavailable only when analyze_email returned an error or no usable analysis.

## flag_email tool
Use for factual IMAP flag changes. Follow the UID contract above before calling this tool.

## delete_email tool
Use for deletion. Follow the UID contract above before calling this tool. Do not claim success unless the tool confirms it.

## author_email tool
Use to prepare, revise, or propose draft content without sending. Use this whenever the user wants help writing but has not clearly asked to deliver the message yet.

## send_email tool
Use only when the user clearly wants the email delivered. Do not send when the user is only brainstorming, drafting, asking for edits, or asking what to write.
`.trim();
}

function buildEmailPromptAgentDefinition() {
  const { modelDeploymentName } = getRequiredFoundryFamilyConfig(EMAIL_FAMILY);

  return {
    kind: 'prompt',
    model: modelDeploymentName,
    instructions: buildEmailAgentInstructions(),
    tools: buildEmailToolDefinitions(),
  };
}

function normalizePromptAgentName(agent, fallbackAgentName = null) {
  return String(agent?.name ?? agent?.id ?? fallbackAgentName ?? '').trim() || null;
}

function normalizePromptAgentTimestamp(agent) {
  return agent?.updatedAt
    ?? agent?.updated_at
    ?? agent?.updatedOn
    ?? agent?.updated_on
    ?? agent?.lastModifiedAt
    ?? agent?.last_modified_at
    ?? agent?.lastModified
    ?? agent?.last_modified
    ?? agent?.createdAt
    ?? agent?.created_at
    ?? agent?.createdOn
    ?? agent?.created_on
    ?? agent?.versions?.latest?.updatedAt
    ?? agent?.versions?.latest?.updated_at
    ?? agent?.versions?.latest?.updatedOn
    ?? agent?.versions?.latest?.updated_on
    ?? agent?.versions?.latest?.lastModifiedAt
    ?? agent?.versions?.latest?.last_modified_at
    ?? agent?.versions?.latest?.lastModified
    ?? agent?.versions?.latest?.last_modified
    ?? agent?.versions?.latest?.createdAt
    ?? agent?.versions?.latest?.created_at
    ?? agent?.versions?.latest?.createdOn
    ?? agent?.versions?.latest?.created_on
    ?? null;
}

export async function getPublishedEmailPromptAgent() {
  const project = getProjectClient();
  const { agentName } = getRequiredFoundryFamilyConfig(EMAIL_FAMILY);

  try {
    return await project.agents.get(agentName, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    throw new Error(
      `Foundry agent "${agentName}" was not found. Publish the email family before calling /api/chat.`,
    );
  }
}

export async function getEmailPromptAgentPublishStatus() {
  const { agentName } = getRequiredFoundryFamilyConfig(EMAIL_FAMILY);

  try {
    const agent = await getPublishedEmailPromptAgent();

    return {
      promptAgentStatus: 'published',
      promptAgentName: normalizePromptAgentName(agent, agentName),
      lastPublishedAt: normalizePromptAgentTimestamp(agent),
      toolCount: buildEmailToolDefinitions().length,
      excludedTreeCount: 0,
      agent,
    };
  } catch (error) {
    if (isNotFoundError(error) || String(error?.message ?? '').includes('was not found')) {
      return {
        promptAgentStatus: 'not_published',
        promptAgentName: agentName,
        lastPublishedAt: null,
        toolCount: buildEmailToolDefinitions().length,
        excludedTreeCount: 0,
        agent: null,
      };
    }

    throw error;
  }
}

export async function publishEmailPromptAgent() {
  const project = getProjectClient();
  const { agentName } = getRequiredFoundryFamilyConfig(EMAIL_FAMILY);
  const definition = buildEmailPromptAgentDefinition();
  let agent;

  try {
    agent = await project.agents.update(agentName, definition, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    agent = await project.agents.create(agentName, definition, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });
  }

  return {
    promptAgentStatus: 'published',
    promptAgentName: normalizePromptAgentName(agent, agentName),
    lastPublishedAt: normalizePromptAgentTimestamp(agent),
    toolCount: buildEmailToolDefinitions().length,
    excludedTreeCount: 0,
    agent,
  };
}

export async function unpublishEmailPromptAgent() {
  const { agentName } = getRequiredFoundryFamilyConfig(EMAIL_FAMILY);

  try {
    await deleteProjectPromptAgent(agentName);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  return {
    promptAgentStatus: 'not_published',
    promptAgentName: agentName,
    lastPublishedAt: null,
    toolCount: buildEmailToolDefinitions().length,
    excludedTreeCount: 0,
    agent: null,
  };
}

function buildEmailHandlerMap({ includeDebug = false, updatedBy = null, personalCacheTreeId = null } = {}) {
  const handlerMap = new Map();

  handlerMap.set(RETRIEVE_EMAILS_TOOL, buildRetrieveEmailsHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(ANALYZE_EMAIL_TOOL, buildAnalyzeEmailHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(FLAG_EMAIL_TOOL, buildFlagEmailHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(DELETE_EMAIL_TOOL, buildDeleteEmailHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(AUTHOR_EMAIL_TOOL, buildAuthorEmailHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(SEND_EMAIL_TOOL, buildSendEmailHandler({ includeDebug, personalCacheTreeId }));

  return handlerMap;
}

export function buildEmailRuntimeContext(options = {}) {
  return {
    tools: buildEmailToolDefinitions(),
    handlerMap: buildEmailHandlerMap({
      includeDebug: Boolean(options.includeDebug),
      updatedBy: options.updatedBy ?? null,
      personalCacheTreeId: options.personalCacheTreeId ?? null,
    }),
  };
}