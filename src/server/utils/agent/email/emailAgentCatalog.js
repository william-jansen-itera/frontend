import {
  AGENT_PREVIEW_FEATURES,
  deleteProjectPromptAgent,
  getProjectClient,
  getRequiredFoundryFamilyConfig,
  isNotFoundError,
} from '@/server/utils/foundryAgentClient';
import {
  DRAFT_EMAIL_TOOL,
  buildDraftEmailHandler,
  draftEmailToolDefinition,
} from '@/server/utils/agent/email/tools/draftEmailTool';
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
  buildShowEmailHandler,
  showEmailToolDefinition,
  SHOW_EMAIL_TOOL,
} from '@/server/utils/agent/email/tools/showEmailTool';
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
import {
  buildUnsubscribeEmailHandler,
  unsubscribeEmailToolDefinition,
  UNSUBSCRIBE_EMAIL_TOOL,
} from '@/server/utils/agent/email/tools/unsubscribeEmailTool';

export const EMAIL_FAMILY = 'email';

function buildEmailToolDefinitions() {
  return [
    retrieveEmailsToolDefinition,
    showEmailToolDefinition,
    analyzeEmailToolDefinition,
    deleteEmailToolDefinition,
    flagEmailToolDefinition,
    draftEmailToolDefinition,
    sendEmailToolDefinition,
    unsubscribeEmailToolDefinition,
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
Before show_email, analyze_email, flag_email, delete_email, or unsubscribe_email, look up the target email rows in the latest retrieve_emails result in this conversation.
Read data.emails[].uid. It is a string, for example "19613". Copy that string unchanged into the tool arguments, and copy data.folder into folder.
Do this even if an earlier answer did not mention the UID. The answer is not the source. The tool result is.
Do not use the array index, data.resultCount, or meta.resultCount. Do not invent, shorten, or retype a UID.
If this conversation has no retrieve_emails result, call retrieve_emails first, then copy data.emails[].uid from that result.
If a call rejects a UID, look up data.emails[].uid in the latest retrieve_emails result again and retry once with those strings. Do not invent a replacement and do not ask the user for UIDs.
Ask the user only if no retrieve_emails result exists and a retrieval cannot be made, or none of its rows match the request. Then show subject and data.emails[].uid from that result and stop.
For show_email, analyze_email, flag_email, and delete_email, pass a uids list even for one email. For unsubscribe_email, pass one uid string.

## retrieve_emails tool
Use this tool for discovery and for any factual claim about which emails exist.
Reuse the latest retrieve_emails result when it already contains the emails needed for a follow-up. Do not retrieve again only because the user asked about emails already in that result.
If the first retrieval is too broad, too narrow, or misses the likely target, retrieve again with a refined query instead of guessing.
Use the returned rows to choose what to analyze, flag, delete, or use as draft context.
The tool may answer from a cached folder snapshot and only contacts IMAP when the snapshot is stale or forceRefresh is true.
When lastCheckedAt is present, mention when the snapshot was last checked. When usedCachedSnapshot is true, offer a fresh check.
When answering from retrieve_emails, state the limit used from data.query.limit whenever you summarize the result set or say how many emails were returned.
Use the returned heuristic classification, action, and deadline fields for list-level triage before analyze_email. Prefer them when they are enough. Enable only the heuristics the question needs.
When present, use attachmentFileNames to mention attached file names directly from the retrieval result.
When present, use unsubscribe metadata as a parsed signal based on whether unsubscribe keywords such as unsubscribe, afmeld, or afmelde appear in the email headers or body.
If data.emails[].unsubscribe.detected is true, summarize unsubscribe.type. It will be either actionable or manual.
If data.emails[].unsubscribe.detected is false, treat unsubscribe.type as null.
If data.emails[].unsubscribe.hasLink is true and data.emails[].unsubscribe.type is not manual, you may say the message exposes an unsubscribe link and summarize unsubscribe.link.
If data.emails[].unsubscribe.type is actionable, that means the agent can execute the unsubscribe.
If data.emails[].unsubscribe.type is manual, tell the user the email appears to require manual unsubscribe. In that case, unsubscribe.link is the manual link when one was found, so include the entire unsubscribe.link verbatim when present. Summarize unsubscribe.manualInstructionText when present. If the manual metadata is incomplete, inspect the shown email content to explain the unsubscribe instructions rather than claiming the tool can execute it.
Do not claim an actionable unsubscribe path unless unsubscribe.type is actionable.
Use hasUnsubscribeOptionOnly when the user asks to list or find emails that offer any unsubscribe path.
Use hasAutomatedUnsubscribeOptionOnly when the user asks to list or find emails whose unsubscribe path can be automated by the tool.
Signals that matter: sender, subject wording, topic keywords, recency, unread, flagged, reply expectation, deadline mentions.
folder defaults to INBOX unless the user names another folder.
Treat phrases like "get emails from X" as a sender filter by default, usually using fromContains. Do not reinterpret "from X" as the email provider or account unless the user explicitly names the provider, account, mailbox, or says Hover.
When you use fromContains from the user's wording, preserve the sender phrase literally and keep the original word order except for trivial whitespace cleanup. Do not paraphrase, reorder, translate, or normalize branded sender phrases.
Example: if the user says "retrieve all emails from lounge by zalando", prefer fromContains: "lounge by zalando", not "zalando lounge".
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
Use this tool only for a deeper read than the retrieve_emails heuristics and the initial cached information.
Use analyze_email for interpretation, classification, prioritization, reasoning, summarization across multiple details, or when the user asks what an email means, what it requires, whether it needs a reply, or what action should be taken.
Do not use analyze_email for simple factual extraction that can be read directly from the cached email body.
Batch emails that need the same deeper read into one call when they are in the same folder.
The response always returns data.analyses, including when only one email was analyzed.
Answer from data.analyses[].summary, data.analyses[].classification, data.analyses[].replyItems, data.analyses[].questionItems, data.analyses[].actionItems, and data.analyses[].deadlineItems.
Say that detailed content is unavailable only when analyze_email returned an error or no usable analysis.

## show_email tool
Use this tool to display one cached email without model analysis.
Use show_email for simple extraction from the email body or headers, for example names, dates, amounts, invoice numbers, discount codes, case numbers, unsubscribe instructions, links, phone numbers, addresses, or specific quoted text.
When the user asks to open emails and extract concrete facts from each one, prefer show_email over analyze_email.
Batch emails that need straightforward extraction into one call when they are in the same folder.
Answer from data.emails[].subject, data.emails[].from, data.emails[].receivedAt, data.emails[].flags, data.emails[].preview, data.emails[].bodyText, data.emails[].attachmentFileNames, and data.emails[].unsubscribe when relevant.
When you show emails, include each uid in the answer. Prefer the format: subject — uid <data.emails[].uid>.
Use the returned heuristicClassification, replyItems, actionItems, and deadlineItems when they help, but do not describe them as model analysis.
If the user only needs straightforward extraction, prefer show_email over analyze_email.

## flag_email tool
Use for factual IMAP flag changes.
This tool only sets or removes the visual flagged or starred state for the target emails.
Batch same-folder emails that need the same flag change into one call.

## delete_email tool
Use for deletion. Do not claim success unless the tool confirms it.
With expunge false, this tool moves messages to Trash. Use expunge true only when the user clearly wants permanent deletion.
Batch same-folder emails that need the same delete action into one call.

## unsubscribe_email tool
Use for actual unsubscribe actions.
Use this only when the user clearly wants to unsubscribe, not when they are only asking whether an unsubscribe option exists.
Call this tool only for emails whose metadata has unsubscribe.type equal to actionable and unsubscribe.hasLink equal to true. Do not call it for manual unsubscribe detections or emails that do not expose a parsed unsubscribe link.
Set confirm to true only after the user explicitly confirms the unsubscribe action for that email.
Do not invent unsubscribe URLs or methods. This tool must act only on parsed unsubscribe link metadata returned from retrieve_emails or from one of the emails in data.emails[] returned by show_email.
This tool supports automated HTTP(S) unsubscribe URLs and mailto unsubscribe targets. For mailto targets, it sends the unsubscribe email through the configured SMTP account using the parsed mailto recipient, subject, and body when present.
If the tool succeeds with actionType equal to http_request, read data.action.responseText before deciding whether the unsubscribe completed. Do not treat HTTP 200, a successful tool call, or finalUrl alone as confirmation.
If data.action.responseText is missing, ambiguous, or describes a further click, confirmation, or preference step, say that the unsubscribe is not confirmed as completed and include the complete unsubscribe page link verbatim in the answer. Prefer data.action.finalUrl when present; otherwise use data.action.url.
Only say the unsubscribe completed when data.action.responseText explicitly confirms completion.

## draft_email tool
Use this tool to save a draft to the Drafts mailbox without sending it.
Do not call this tool before the user has finished iterating on wording, asking for edits, or discussing alternatives.
Never call this tool as a staging step immediately before send_email. If the user wants the message delivered now, use send_email directly.
Only call this tool after the user explicitly indicates that the draft is ready to be saved, for example by clearly confirming to save it, create the draft, or put it in Drafts.
Set confirm to true only after the user explicitly confirms saving the draft.
If the user has not yet chosen between sending now and saving a draft, ask which they want before calling either draft_email or send_email.
For a new draft, collect to, subject, and body from the user before calling this tool.
For a reply draft, use the email uid and the same folder value from the latest retrieve_emails result.
In the normal reply case, only the body content must come from the user unless they explicitly want to override recipient or subject.
For reply drafts, default to writing in the same language as the email being replied to unless the user explicitly asks for a different language.
The user does not need to repeat the recipient or subject for a normal reply because the tool can derive them from the referenced email, but the agent must still pass folder and uid from the latest retrieve_emails result.
If the user explicitly provides to or subject while replying, pass those values and let them override the values derived from the referenced email.
Do not call this tool with a uid unless the uid comes from the latest retrieve_emails result in this conversation.
If this tool succeeds and data.draftUid is present, you must mention both data.draftFolder and data.draftUid explicitly in the answer.
Do not omit that information when it is present in the tool output.
Use that reported draft folder and draft uid later as the saved draft location.
Do not use this tool to send the email. Use send_email only when the user clearly wants delivery.

## send_email tool
Use only when the user clearly wants the email delivered. Do not send when the user is only brainstorming, drafting, asking for edits, or asking what to write.
If the user says to send the current composed email or reply now, call send_email directly and do not call draft_email first.
For reply sends, use the retrieved source email folder and uid together with the final body content directly when needed. Do not save a draft first unless the user explicitly asked to save a draft.
Use a draft folder and draft uid only when the user explicitly wants to send a previously saved draft or the conversation is already working from a saved draft.
When folder and uid point to a non-draft email such as an Inbox message, treat them as the source email being replied to. Do not treat that email as a saved draft and do not delete it after sending.
For a direct send, collect the final to, subject, and body content first.
For reply sends, default to writing in the same language as the email being replied to unless the user explicitly asks for a different language.
For normal reply sends, do not invent or rewrite the subject line. Omit subject so the tool can preserve the original reply subject unless the user explicitly asks to change it.
Only pass subject on a reply send when the user explicitly wants a different subject line.
To send a previously saved draft from a mailbox folder, pass the draft folder and draft uid. Use a Drafts folder uid only when it comes from retrieve_emails for that folder or from the latest draft_email result.
When both explicit message fields and a draft uid are present, treat the draft as the base message and let the explicit fields override it.
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
  handlerMap.set(SHOW_EMAIL_TOOL, buildShowEmailHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(ANALYZE_EMAIL_TOOL, buildAnalyzeEmailHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(FLAG_EMAIL_TOOL, buildFlagEmailHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(DELETE_EMAIL_TOOL, buildDeleteEmailHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(DRAFT_EMAIL_TOOL, buildDraftEmailHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(SEND_EMAIL_TOOL, buildSendEmailHandler({ includeDebug, personalCacheTreeId }));
  handlerMap.set(UNSUBSCRIBE_EMAIL_TOOL, buildUnsubscribeEmailHandler({ includeDebug, updatedBy, personalCacheTreeId }));

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