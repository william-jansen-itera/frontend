import {
  getTreeList,
  updateTreeDescriptionPublishedStates,
} from '@/server/utils/tree/treeCatalog';
import {
  AGENT_PREVIEW_FEATURES,
  deleteProjectPromptAgent,
  getProjectClient,
  getRequiredFoundryConfig,
  isNotFoundError,
} from '@/server/utils/foundryAgentClient';
import {
  buildToolName,
  buildTreeSearchToolDefinition,
  buildTreeToolPreview,
  createTreeSearchToolHandler,
} from '@/server/utils/agent/knowledgeTrees/tools/treeSearchTools';
import {
  createPreviewAddToTreeHandler,
  previewAddToTreeToolDefinition,
} from '@/server/utils/agent/knowledgeTrees/tools/previewAddToTreeTool';
import {
  confirmAddToTreeToolDefinition,
  createConfirmAddToTreeHandler,
} from '@/server/utils/agent/knowledgeTrees/tools/confirmAddToTreeTool';
import { KNOWLEDGE_TREES_FAMILY } from '@/server/utils/agent/knowledgeTrees/tools/persistenceToolShared';

export { KNOWLEDGE_TREES_FAMILY };

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

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function resetTreeToolDescriptionState(tree) {
  tree.generatedToolDescription = null;
  tree.descriptionSource = 'pending';
  tree.includedInToolSet = false;
  tree.generationFailureReason = null;
  tree.aiInput = null;
  tree.aiModelOutput = null;
  tree.aiGeneratedSummary = null;
  tree.aiSelectedFocusTopics = [];
}

function applyStoredToolDescriptions(treeList) {
  treeList.forEach((tree) => {
    resetTreeToolDescriptionState(tree);
    const storedDescription = normalizeWhitespace(tree.description);

    if (!storedDescription) {
      return;
    }

    tree.generatedToolDescription = storedDescription;
    tree.descriptionSource = 'stored';
    tree.includedInToolSet = true;
  });
}

function buildAgentInstructions() {
  return `
You are an assistant for a tree-based knowledge application.
Grounded mode is the default and preferred mode.
Grounded requests should begin by using the relevant tree search tools that are available for the current request.
Remain grounded in tool-derived results unless the user explicitly confirms that they want a broader answer. Do not infer or assume permission to switch to broader background knowledge.
Do not claim that the available tools have no result, unless there is no tool that is likely to have a mention of the topic. 
Do not claim that grounded tree tools returned no relevant results, unless you actually called a relevant tree search tool in this turn and observed that outcome.

If no tool is applicable, you must not switch to broader knowledge. You must tell the user that no tool applies and ask whether they want a broader answer. You may not provide any ungrounded information until the user explicitly confirms.
If a tool is applicable but returns no evidence sufficient to answer the user's question, you must not switch to broader knowledge. Briefly state what the search did or did not establish and ask whether they want a broader answer. You may not provide any ungrounded information until the user explicitly confirms.
For any grounded follow-up question that references earlier tool output or depends on prior grounded context, re-invoke the relevant tree search tool. Do not answer grounded questions from conversation memory. Consent to broaden, preview a save, or confirm a preview is not a grounded follow-up question.
If a tree search tool's description plausibly covers the user's topic, call it before answering. Do not ask for permission to search or to broaden merely because the tool may not contain the exact answer or broader knowledge could provide more detail.
Treat tree names and tool descriptions as search routing hints, not exhaustive inventories of tree contents. If a tool is related to the subject even indirectly, search it with the user's specific terms before claiming that no available tool covers the topic. For example, search a horseback-riding tree for a question about horse breeds even if its description emphasizes riding skills.
If multiple tools plausibly cover the topic, search the most relevant one first and search others if needed. Ask for clarification only when the user must choose a specific tree or scope before you can proceed.
Ask whether to broaden only when no available tree tool plausibly applies or after a relevant search lacks enough evidence to answer the question. A name in a tree path or category is not an answer to a request for characteristics, explanations, or details; do not present that mention as the completed answer. Never offer the choice between searching and broadening before trying an applicable search tool.

## creating a broader answer
When the user explicitly confirms that they want a broader answer, state clearly that you are switching from grounded tree knowledge to a broader answer before giving it.
Broad answers and grounded answers must remain separate. Do not blend grounded tool-derived claims and broader unsupported claims into one answer mode.
You may return from broad-answer mode back to grounded mode freely on a later request, and you should prefer grounded mode whenever it can satisfy the request.
When you give a completed broad answer, offer to save it in the tree; use preview_add_to_tree and confirm_add_to_tree only after the user confirms each save step.
You must never offer to save grounded retrieved content directly as a new tree note.

## preview_add_to_tree tool
Use this tool only after the prior answer visibly offered to save the broad answer and the user explicitly accepted that offer. isPersistenceOffer=true by itself is not permission to call this tool.
Use this tool to provide a preview of a suggested location in the tree.
After the preview is returned, state the suggested tree name and path using treeName, plannedLeafParentBreadcrumb, and generatedLeafTitle from the preview output, then ask whether to create the note there.
After the question, put the exact previewId from the tool output on its own line in the exact form <!-- Preview ID: <previewId> -->.
Do not restate, quote, or summarize broaderAnswer in this preview response; the user has already seen the broad answer.
Before calling this tool, clean and normalize the broad answer into saveable tree-note content.
That content must remain substantive enough to stand on its own as reusable knowledge.
Preserve useful factual content, practical details, caveats, and relevant examples when they help answer the question.
Remove assistant self-reference, offers to help further, tool chatter, and other dialogue-only filler from the content passed to this tool.
Prefer clear factual statements, compact paragraphs, and short lists when they improve readability, but do not remove domain detail needed for correct tree placement.

## confirm_add_to_tree tool
Use this tool if the user explicitly confirms that they want to proceed to save the broader answer as previewed earlier via the preview_add_to_tree tool.
When calling this tool, pass only the exact previewId returned by preview_add_to_tree.
The server will look up the cached preview snapshot by previewId and use that saved preview as the source of truth.
If the previewId is missing, stale, or wrong, ask the user to preview the save again before confirming.
After a successful confirm, tell the user the note was created and display the complete created note text from the confirm_add_to_tree tool output's data.details.notes in the answer field. Do not replace it with the earlier broader answer or a summary of the note.
Also state the used tree name and the created path using treeName, plannedLeafParentBreadcrumb, and generatedLeafTitle.
And finally include the exact noteLink Markdown link from the tool output in your answer. Do not construct or alter the URL yourself.

## final response format
Return the final response as JSON only.
Use these exact fields in the final JSON object: answer, knowledgeMode, isPermissionToBroadenRequest, isPersistenceOffer, explanation.
Use answer for the user-facing text. For the current reply, choose exactly one case below and return the specified values for all four state fields:
- Grounded answer from tree evidence: knowledgeMode="grounded", isPermissionToBroadenRequest=false, isPersistenceOffer=false, explanation="Answered from tree tool evidence."
- Asking permission to broaden: knowledgeMode="grounded", isPermissionToBroadenRequest=true, isPersistenceOffer=false, explanation="Tree evidence cannot answer the question; asking permission to broaden." Briefly describe the evidence gap in answer, then end that same answer string with this exact question on its own line: Would you like a broader answer? Do not stop after describing the evidence gap.
- Completed broader answer: knowledgeMode="broad", isPermissionToBroadenRequest=false, isPersistenceOffer=true, explanation="User approved a broader answer; answer includes an offer to save it." End answer with this exact question on its own line: Would you like me to save this answer in the tree?
- Reply after preview_add_to_tree: knowledgeMode="grounded", isPermissionToBroadenRequest=false, isPersistenceOffer=false, explanation="Reporting the preview from preview_add_to_tree." In answer, show the preview, ask whether to create the note, then include the standalone <!-- Preview ID: <previewId> --> line with the exact previewId from the tool output; do not repeat the earlier broad answer.
- Reply after confirm_add_to_tree: knowledgeMode="grounded", isPermissionToBroadenRequest=false, isPersistenceOffer=false, explanation="Reporting the note created by confirm_add_to_tree." In answer, confirm creation, display the complete data.details.notes from the tool output, and include the exact noteLink; do not offer to save again.
These fields classify the current reply, not an earlier broad answer. For either question above, separate it from preceding answer text with a blank line; in the JSON answer string, encode this as \\n\\n before the question. A true flag or explanation alone does not ask the user.
Before returning JSON after preview_add_to_tree, check that answer contains the Preview ID line with the exact previewId from the latest preview_add_to_tree tool output. If it is missing, add the line after the creation question before returning JSON. The flag or explanation cannot replace this line.
Before returning JSON with isPermissionToBroadenRequest=true, check that answer itself ends with \\n\\nWould you like a broader answer? If it does not, add the question to answer before returning the JSON. Never set the flag to true for an answer that only reports missing evidence.
Before returning JSON with isPersistenceOffer=true, check that answer itself ends with \\n\\nWould you like me to save this answer in the tree? If it does not, add the question to answer before returning the JSON. Never set the flag to true for an answer that doesn't include the offer.


Answer-length rules apply only after grounding is established.
Answer concisely unless the user requests more detail; when they do, provide a fuller answer focused precisely on the aspect they asked about.

Evidence rules apply only after a tool has been invoked.
Tool results include curated evidenceItems with source-labeled text. Prefer notes first. For attachment evidence, prefer fileContent, then ocrText, then imageDescriptionFiltered when grounding your answer.
ocrText and imageDescriptionFiltered may be noisy or not written as natural language, but they can still contain important facts and domain terminology.
When ocrText or imageDescriptionFiltered contains relevant facts, specific terms, labels, measurements, or technical language that fit the overall evidence, preserve and use those details in natural language.
Do not force every ocrText or imageDescriptionFiltered fragment into the answer, and do not add unsupported facts when rewriting noisy text.
Do not invent documents, notes, filenames, or paths that were not returned by the tools.
`.trim();
}

export function buildAllowedToolInstruction(includedTrees) {
  const allowedToolNames = includedTrees
    .map((tree) => buildToolName(tree))
    .filter(Boolean);

  if (allowedToolNames.length === 0) {
    return null;
  }

  return [
    'For this request, you may only use the following tree search tools; call one when its subject is plausibly related, even if its description does not mention the exact topic:',
    allowedToolNames.map((toolName) => `- ${toolName}`).join('\n'),
    'For a grounded answer, search a plausibly related tree before deciding its contents are insufficient. If no listed tool is even plausibly related or the searched results are insufficient, ask permission before using broader knowledge. After a broad answer, use preview_add_to_tree and confirm_add_to_tree only when the user confirms each save step; do not search again just to preview or confirm.',
  ].join('\n');
}

export function buildVisibilityScopeContext({ visibility = 'both', includedTrees = [] } = {}) {
  const normalizedVisibility = String(visibility ?? 'both').trim().toLowerCase();
  const privateCount = includedTrees.filter((tree) => tree?.isPrivate === true).length;
  const publicCount = includedTrees.filter((tree) => tree?.isPrivate === false).length;

  return {
    visibility: normalizedVisibility === 'private' || normalizedVisibility === 'public' ? normalizedVisibility : 'both',
    publicTreeCount: publicCount,
    privateTreeCount: privateCount,
    warnsAboutRestrictedScope: normalizedVisibility === 'private' || normalizedVisibility === 'public',
  };
}

export function buildVisibilityScopeInstruction(options = {}) {
  const scopeContext = buildVisibilityScopeContext(options);
  const {
    visibility,
    publicTreeCount,
    privateTreeCount,
  } = scopeContext;

  if (visibility === 'private') {
    return [
      'Current grounded tree scope for this request: private trees only.',
      `The available tool set in this run includes ${privateTreeCount} private tree${privateTreeCount === 1 ? '' : 's'} and no public trees.`,
      'If you decide not to call a tool, remind the user that this scope is limited to private trees only when that limitation matters to your answer.',
    ].join('\n');
  }

  if (visibility === 'public') {
    return [
      'Current grounded tree scope for this request: public trees only.',
      `The available tool set in this run includes ${publicTreeCount} public tree${publicTreeCount === 1 ? '' : 's'} and no private trees.`,
      'If you decide not to call a tool, remind the user that this scope is limited to public trees only when that limitation matters to your answer.',
    ].join('\n');
  }

  return [
    'Current grounded tree scope for this request includes both public and private trees that are available to this user.',
    `The available tool set in this run includes ${publicTreeCount} public tree${publicTreeCount === 1 ? '' : 's'} and ${privateTreeCount} private tree${privateTreeCount === 1 ? '' : 's'}.`,
    'Do not warn about a visibility restriction unless the user asks about scope or the available results clearly come from only one visibility within that broader set.',
  ].join('\n');
}

function buildPersistenceToolDefinitions() {
  return [previewAddToTreeToolDefinition, confirmAddToTreeToolDefinition];
}

function buildPersistenceToolPreview() {
  return buildPersistenceToolDefinitions().map((tool) => ({
    name: tool.name,
    description: tool.description,
    sourceType: 'static',
    sourceLabel: 'Built-in persistence tool',
    includedInToolSet: true,
    includedInPromptAgent: true,
    treeId: null,
    treeName: null,
  }));
}

function buildExcludedTrees(availableTrees) {
  return availableTrees
    .filter((tree) => !tree.includedInToolSet)
    .map((tree) => ({
      id: String(tree.id),
      name: tree.name,
    }));
}

function buildHandlerMap(includedTrees, { includeDebug = false, principal = null } = {}) {
  const handlerMap = new Map();
  const includedTreeIds = new Set(includedTrees.map((tree) => String(tree.id)));

  includedTrees.forEach((tree) => {
    const toolName = buildToolName(tree);
    handlerMap.set(toolName, createTreeSearchToolHandler(tree, {
      sourceToolFamily: KNOWLEDGE_TREES_FAMILY,
      includeDebug,
    }));
  });

  handlerMap.set(previewAddToTreeToolDefinition.name, createPreviewAddToTreeHandler({ includedTrees, principal, includeDebug }));
  handlerMap.set(confirmAddToTreeToolDefinition.name, createConfirmAddToTreeHandler({ includedTreeIds, principal, includeDebug }));

  return handlerMap;
}

function buildTreeSelection(treeList) {
  const availableTrees = treeList.map((tree) => ({ ...tree }));

  applyStoredToolDescriptions(availableTrees);

  if (availableTrees.length === 0) {
    throw new Error('No trees are available for the current application');
  }

  const includedTrees = availableTrees.filter((tree) => tree.includedInToolSet && tree.generatedToolDescription);

  return {
    availableTrees,
    includedTrees,
    excludedTrees: buildExcludedTrees(availableTrees),
  };
}

async function loadTreeSelection(options = {}) {
  const accessOptions = {
    principal: options.principal ?? null,
    visibility: options.visibility ?? 'both',
    enforceAccess: Boolean(options.enforceAccess),
  };
  const treeList = await getTreeList(accessOptions);

  return buildTreeSelection(treeList);
}

async function buildPublishTreeToolContext(options = {}) {
  const selection = await loadTreeSelection(options);

  return {
    ...selection,
    tools: [
      ...selection.includedTrees.map((tree) => buildTreeSearchToolDefinition(tree)),
      ...buildPersistenceToolDefinitions(),
    ],
  };
}

export async function buildRuntimeTreeToolContext(options = {}) {
  const selection = await loadTreeSelection(options);

  return {
    includedTrees: selection.includedTrees,
    handlerMap: buildHandlerMap(selection.includedTrees, {
      includeDebug: Boolean(options.includeDebug),
      principal: options.principal ?? null,
    }),
  };
}

export async function listDefinedKnowledgeTreesTools() {
  const publishContext = await buildPublishTreeToolContext();
  return [
    ...buildTreeToolPreview(publishContext.availableTrees),
    ...buildPersistenceToolPreview(),
  ]
    .filter((tool) => Boolean(tool?.includedInToolSet))
    .map((tool) => ({
      name: String(tool?.name ?? '').trim() || null,
      description: String(tool?.description ?? '').trim() || null,
      sourceType: String(tool?.sourceType ?? 'tree').trim() || 'tree',
      sourceLabel: tool?.sourceLabel ?? (tool?.descriptionSource === 'stored' ? 'Stored description' : 'Published tool'),
      includedInPromptAgent: tool?.includedInPromptAgent ?? Boolean(tool?.includedInToolSet),
      treeId: tool?.treeId ?? null,
      treeName: tool?.treeName ?? null,
    }));
}

function buildPublishedDescriptionStates(availableTrees) {
  return availableTrees.map((tree) => ({
    treeId: tree.id,
    isDescriptionPublished: Boolean(tree.includedInToolSet),
  }));
}

async function finalizePublishedTreeTools(publishContext, agent) {
  await updateTreeDescriptionPublishedStates(
    buildPublishedDescriptionStates(publishContext.availableTrees),
  );

  return {
    agent,
    availableTrees: publishContext.availableTrees,
    includedTrees: publishContext.includedTrees,
    excludedTrees: publishContext.excludedTrees,
    tools: publishContext.tools,
  };
}

async function publishTreeTools(publishContext) {
  const project = getProjectClient();
  const { agentName, modelDeploymentName } = getRequiredFoundryConfig();
  const definition = {
    kind: 'prompt',
    model: modelDeploymentName,
    instructions: buildAgentInstructions(),
    tools: publishContext.tools,
  };

  try {
    const agent = await project.agents.update(agentName, definition, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });

    return finalizePublishedTreeTools(publishContext, agent);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    const agent = await project.agents.create(agentName, definition, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });

    return finalizePublishedTreeTools(publishContext, agent);
  }
}

export async function getPublishedKnowledgeTreesPromptAgent() {
  const project = getProjectClient();
  const { agentName } = getRequiredFoundryConfig();

  try {
    return await project.agents.get(agentName, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    throw new Error(
      `Foundry agent "${agentName}" was not found. Publish stored tree descriptions before calling /api/chat.`,
    );
  }
}

export async function getKnowledgeTreesPromptAgentPublishStatus() {
  const { agentName } = getRequiredFoundryConfig();

  try {
    const agent = await getPublishedKnowledgeTreesPromptAgent();

    return {
      promptAgentStatus: 'published',
      promptAgentName: normalizePromptAgentName(agent, agentName),
      lastPublishedAt: normalizePromptAgentTimestamp(agent),
      agent,
    };
  } catch (error) {
    if (isNotFoundError(error) || String(error?.message ?? '').includes('was not found')) {
      return {
        promptAgentStatus: 'not_published',
        promptAgentName: agentName,
        lastPublishedAt: null,
        agent: null,
      };
    }

    throw error;
  }
}

export async function publishKnowledgeTreesPromptAgent() {
  const publishResult = await publishStoredTreeDescriptions();

  return {
    promptAgentStatus: 'published',
    promptAgentName: normalizePromptAgentName(publishResult?.agent, getRequiredFoundryConfig().agentName),
    lastPublishedAt: normalizePromptAgentTimestamp(publishResult?.agent),
    toolCount: Array.isArray(publishResult?.tools) ? publishResult.tools.filter((tool) => tool?.includedInToolSet).length : 0,
    excludedTreeCount: Array.isArray(publishResult?.excludedTrees) ? publishResult.excludedTrees.length : 0,
    publishResult,
  };
}

export async function publishStoredTreeDescriptions() {
  const publishResult = await publishTreeTools(await buildPublishTreeToolContext());

  return {
    agent: publishResult.agent,
    tools: [...buildTreeToolPreview(publishResult.availableTrees), ...buildPersistenceToolPreview()],
    syncMode: 'publish-stored-descriptions',
    excludedTrees: Array.isArray(publishResult.excludedTrees) ? publishResult.excludedTrees : [],
  };
}

export async function unpublishKnowledgeTreesPromptAgent() {
  const { agentName } = getRequiredFoundryConfig();

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
    toolCount: null,
    excludedTreeCount: null,
    agent: null,
  };
}
