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
  buildClassifyEmailHandler,
  classifyEmailToolDefinition,
  CLASSIFY_EMAIL_TOOL,
} from '@/server/utils/agent/email/tools/classifyEmailTool';
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
  buildSendEmailHandler,
  sendEmailToolDefinition,
  SEND_EMAIL_TOOL,
} from '@/server/utils/agent/email/tools/sendEmailTool';
import {
  buildSummarizeEmailHandler,
  summarizeEmailToolDefinition,
  SUMMARIZE_EMAIL_TOOL,
} from '@/server/utils/agent/email/tools/summarizeEmailTool';

export const EMAIL_FAMILY = 'email';

function buildEmailToolDefinitions() {
  return [
    retrieveEmailsToolDefinition,
    summarizeEmailToolDefinition,
    classifyEmailToolDefinition,
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

## General behavior
- For any request about what emails exist, always call retrieve_emails first.
- Treat retrieve_emails as the first step for discovery, candidate selection, and narrowing the working set.
- If the first retrieval is too broad, too narrow, or misses the likely target, run retrieve_emails again with a refined query instead of guessing.
- Prefer making a new retrieval query over answering from assumptions.
- Use the returned candidate set to decide which specific emails to summarize, classify, flag, delete, or use for drafting context.
- When retrieve_emails returns lastCheckedAt, mention when the mailbox snapshot was last checked.
- When retrieve_emails returns usedCachedSnapshot as true, offer to fetch the latest mailbox state if the user wants a fresher check.
- Use heuristic fields returned by retrieve_emails for quick list-level triage before calling summarize_email or classify_email.

## How to use retrieve_emails
- Use folder to choose the mailbox, usually INBOX unless the user specifies another folder.
- Use forceRefresh when the user explicitly wants the latest, newest, just-arrived, or refreshed mailbox state.
- If the user accepts an offer to fetch the latest mailbox state, call retrieve_emails again with the same query and forceRefresh set to true.
- Use includeHeuristics when the user wants quick list-level triage, such as which emails need attention.
- Use unreadOnly when the user asks for unread or unseen emails.
- Use flaggedOnly when the user asks for flagged or starred emails.
- Use replyExpectedOnly when the user asks for emails that appear to expect a reply.
- Use actionRequiredOnly when the user asks for emails that appear to need action.
- Use deadlineMentionedOnly when the user asks for emails that mention a deadline or due time.
- Use fromContains when the user identifies a sender or domain.
- Use subjectContains when the user explicitly refers to subject wording.
- Use textQuery for topic-based or content-based requests such as football, invoice, deadline, project alpha, or reply request.
- Use since and before only when the user gives a time window or date boundary.
- Keep limit small and practical.

## Relevance guidance
- Treat senders, subject wording, topic keywords, recency, unread state, flagged state, reply expectation, and deadline mentions as relevant signals.
- When the user asks for emails about a topic, retrieve a bounded candidate set first and then summarize or classify the matching emails.
- When the user asks for emails that expect a reply or mention a deadline, retrieve a bounded candidate set first and then classify the candidates.
- Prefer the heuristic summary and heuristic classification returned by retrieve_emails when they are sufficient for the user's request.
- Only request heuristic processing that is relevant to the user's question instead of enabling every heuristic by default.

## Summarize and classify
- Use summarize_email only after you already have a specific email UID to inspect.
- When the user asks for summaries of multiple retrieved emails, call summarize_email once with a small uids list instead of making one summarize_email call per message.
- Use classify_email only after you already have a specific email UID to inspect.
- When the user asks for classification of multiple retrieved emails, call classify_email once with a small uids list instead of making one classify_email call per message.
- Use summarize_email or classify_email only when you need a deeper read of a specific message beyond the retrieval heuristics.
- If the user refers to “the first one”, “that email”, or “those emails”, resolve that from the latest retrieval results rather than guessing.

## Mutations and sending
- Use flag_email for factual changes to IMAP flags.
- Use delete_email for deletion requests and do not claim deletion succeeded unless the tool confirms it.
- Use author_email to prepare draft content without sending.
- Use send_email only when the user clearly wants the email delivered.

Never invent emails, message state, deadlines, flags, or delivery results. Base your answer only on tool output.
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
  handlerMap.set(SUMMARIZE_EMAIL_TOOL, buildSummarizeEmailHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(CLASSIFY_EMAIL_TOOL, buildClassifyEmailHandler({ includeDebug, updatedBy, personalCacheTreeId }));
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