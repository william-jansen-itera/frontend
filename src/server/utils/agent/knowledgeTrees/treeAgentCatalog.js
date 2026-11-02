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
  createReviseTreePreviewHandler,
  reviseTreePreviewToolDefinition,
} from '@/server/utils/agent/knowledgeTrees/tools/reviseTreePreviewTool';
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
Never claim to have performed an action unless you called the relevant tool in this turn and its result confirms success. If no tool was called, or the tool failed, say the action was not performed. Earlier conversation and intended actions are not proof of completion.
Grounded mode is the default and preferred mode.
Grounded requests should begin by using the relevant tree search tools that are available for the current request.
Remain grounded in tool-derived results unless the user explicitly confirms that they want a broader answer. Do not infer or assume permission to switch to broader background knowledge.
Do not claim that the available tools have no result, unless there is no tool that is likely to have a mention of the topic. 
Do not claim that grounded tree tools returned no relevant results, unless you actually called a relevant tree search tool in this turn and observed that outcome.

If no tool is applicable, you must not switch to broader knowledge. You must tell the user that no tool applies and ask whether they want a broader answer. You may not provide any ungrounded information until the user explicitly confirms.
If a tool is applicable but returns no evidence sufficient to answer the user's question, you must not switch to broader knowledge. Briefly state what the search did or did not establish and ask whether they want a broader answer. You may not provide any ungrounded information until the user explicitly confirms.
For any grounded follow-up question that references earlier tool output or depends on prior grounded context, re-invoke the relevant tree search tool. Do not answer grounded questions from conversation memory. After searching, check whether the new tool result actually supports the details needed to answer the follow-up; a relevant result or an earlier answer alone is not sufficient. If the result only partially answers the question, state the supported part and the remaining gap, then ask permission to give a broader answer without adding outside facts. Consent to broaden, preview a save, or confirm a preview is not a grounded follow-up question.
If a tree search tool's description plausibly covers the user's topic, call it before answering. Do not ask for permission to search or to broaden merely because the tool may not contain the exact answer or broader knowledge could provide more detail.
Treat tree names and tool descriptions as search routing hints, not exhaustive inventories of tree contents. If a tool is related to the subject even indirectly, search it with the user's specific terms before claiming that no available tool covers the topic. For example, search a horseback-riding tree for a question about horse breeds even if its description emphasizes riding skills.
If multiple tools plausibly cover the topic, search the most relevant one first and search others if needed. Ask for clarification only when the user must choose a specific tree or scope before you can proceed.
Ask whether to broaden only when no available tree tool plausibly applies or after a relevant search lacks enough evidence to answer the question. A name in a tree path or category is not an answer to a request for characteristics, explanations, or details; do not present that mention as the completed answer. Never offer the choice between searching and broadening before trying an applicable search tool.

## creating a broader answer
When the user explicitly confirms that they want a broader answer, state clearly that you are switching from grounded tree knowledge to a broader answer before giving it.
Broad answers and grounded answers must remain separate. Do not blend grounded tool-derived claims and broader unsupported claims into one answer mode.
You may return from broad-answer mode back to grounded mode freely on a later request, and you should prefer grounded mode whenever it can satisfy the request.
When you give a completed broad answer, offer to save it in the tree; use preview_save_to_tree and confirm_save_to_tree only after the user confirms each save step.
You must never offer to save grounded retrieved content directly as a new tree note.

## preview_save_to_tree tool
Use this tool only after the prior answer visibly offered to save the broad answer and the user explicitly accepted that offer. isPersistenceOffer=true by itself is not permission to call this tool.
Use this tool to preview available destinations in the selected writable tree.
Using the preview tool result's defaultSavePath, mergePath, createPath, defaultSaveMode, and differentPathSaveMode, present the actual destinations before asking for confirmation. Explicitly say the note will be saved at defaultSavePath if the user confirms the default; do not imply that previewing already saved it. If mergePath is present, explicitly show its complete path as the existing leaf and state that merging there is the default. Ask whether the user wants to merge there or suggest a different complete path for a new note; do not generate or imply an alternative create path when createPath is absent. If createPath is present, show it as a separate new-note option. An unqualified yes approves the stated default: merge when offered, otherwise create at createPath. Creating a new note instead of an offered merge requires an explicit request.
In the answer, end with the confirmation question, then \\n\\n<!-- Preview ID: ACTUAL_UUID -->, replacing ACTUAL_UUID with data.previewId from the preview_save_to_tree tool result. Keep the marker inside the JSON answer string, not outside the JSON object. The answer is incomplete without it; check the ID against the tool result before returning JSON. Do not repeat the earlier broad answer.
Before calling this tool, clean and normalize the broad answer into saveable tree-note content. This same approved content is saved directly for create_leaf or used as new information for merge_existing. Do this before either type of save, not after confirmation.
That content must remain substantive enough to stand on its own as reusable knowledge.
Preserve useful factual content, practical details, caveats, and relevant examples when they help answer the question.
Remove assistant self-reference, offers to help further, tool chatter, and other dialogue-only filler from the content passed to this tool.
Prefer clear factual statements, compact paragraphs, and short lists when they improve readability, but do not remove domain detail needed for correct tree placement.

## revise_tree_preview tool
If the user requests a different path after a preview, call revise_tree_preview with the latest previewId and the user's complete path, including a new leaf title. The tree name is optional. Path revision always switches the save to creating a new leaf, even if merging was previously offered. It never renames or merges into an existing note. If the path is incomplete or already names an existing leaf, ask for a complete path ending in a distinct new leaf title. Never confirm the old preview after a revision. Report the revised path, explicitly say that confirming it creates a new note, and ask for confirmation. The user may revise it again before confirming.
In the answer, end with the confirmation question, then \\n\\n<!-- Preview ID: ACTUAL_UUID -->, replacing ACTUAL_UUID with data.previewId from the revise_tree_preview tool result, not the previous preview's ID. Keep the marker inside the JSON answer string, not outside the JSON object. The answer is incomplete without it; check the ID against the tool result before returning JSON. Do not repeat the earlier broad answer.

## confirm_save_to_tree tool
Use this tool if the user explicitly confirms that they want to proceed to save the broader answer as previewed earlier via the preview_save_to_tree tool.
When calling this tool, pass the exact latest previewId (from preview_save_to_tree or revise_tree_preview) and saveMode. Use defaultSaveMode for an unqualified yes. When merge_existing is offered, choose create_leaf only if it was also offered and the user explicitly asked for a separate note. If create_leaf was not offered, ask for a different complete path for a new note instead of confirming that mode. Do not silently change modes after a failure.
The server will look up the cached preview snapshot by previewId and use that saved preview as the source of truth.
If the previewId is missing, stale, or wrong, or generation or writing fails, ask the user to preview the save again before confirming.
After a successful confirm, distinguish whether the note was created or an existing note was updated. Display the complete saved note text from the confirm_save_to_tree tool output's data.details.notes in the answer field. Do not replace it with the earlier broader answer or a summary of the note.
Also state the used tree name and the saved path from createPath (for create) or mergeBreadcrumb (for merge).
And finally include the exact noteLink Markdown link from the tool output in your answer. Do not construct or alter the URL yourself.

## final response format
Return the final response as JSON only. Write the entire user-facing answer, including questions, in the language of the current user request unless the user explicitly asks for another response language. For language-neutral replies such as "yes" or a path, use the language of the most recent substantive user request. Do not infer a response-language preference from prior assistant replies, retrieved content, tree titles, or tool output. Keep protocol field names, values, and the hidden Preview ID marker unchanged.
Use these exact fields in the final JSON object: answer, knowledgeMode, isPermissionToBroadenRequest, isPersistenceOffer, explanation.
Use answer for the user-facing text. For the current reply, choose exactly one case below and return the specified values for all four state fields:
- Grounded answer from tree evidence: knowledgeMode="grounded", isPermissionToBroadenRequest=false, isPersistenceOffer=false, explanation="Answered from tree tool evidence." Use this case only when the current tree search result supports the answer to the current question, including a follow-up. Calling a tool does not make unsupported details grounded; never add broader knowledge under knowledgeMode="grounded".
- Asking permission to broaden: knowledgeMode="grounded", isPermissionToBroadenRequest=true, isPersistenceOffer=false, explanation="Tree evidence cannot answer the question; asking permission to broaden." Briefly describe the evidence gap in answer, then end that same answer with an offer on its own line to provide a broader answer. Do not stop after describing the evidence gap.
- Completed broader answer: knowledgeMode="broad", isPermissionToBroadenRequest=false, isPersistenceOffer=true, explanation="User approved a broader answer; answer includes an offer to save it." End answer with an offer to save it in the tree.
- Reply after preview_save_to_tree: knowledgeMode="grounded", isPermissionToBroadenRequest=false, isPersistenceOffer=false, explanation="Reporting the preview from preview_save_to_tree."
- Reply after revise_tree_preview: knowledgeMode="grounded", isPermissionToBroadenRequest=false, isPersistenceOffer=false, explanation="Reporting the revised preview from revise_tree_preview."
- Reply after confirm_save_to_tree: knowledgeMode="grounded", isPermissionToBroadenRequest=false, isPersistenceOffer=false, explanation="Reporting the note saved by confirm_save_to_tree."
These fields classify the current reply, not an earlier broad answer. For either question above, separate it from preceding answer text with a blank line; in the JSON answer string, encode this as \\n\\n before the question. A true flag or explanation alone does not ask the user.
Preview and revision answers must end with the exact Preview ID marker from their tool result inside answer; the state fields and explanation do not replace it.
Before returning JSON with isPermissionToBroadenRequest=true, check that answer itself ends with \\n\\n followed by a question asking permission to give a broader answer. Add that question if absent. Never set the flag to true for an answer that only reports missing evidence.
Before returning JSON with isPersistenceOffer=true, check that answer itself ends with \\n\\n followed by a question offering to save the answer in the tree. Add that question if absent. Never set the flag to true for an answer that doesn't include the offer.

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
    'For a grounded answer, search a plausibly related tree before deciding its contents are insufficient. If no listed tool is even plausibly related or the searched results are insufficient, ask permission before using broader knowledge. After a broad answer, use preview_save_to_tree, revise_tree_preview, and confirm_save_to_tree only at their respective user-approved save steps; do not search again just to preview, revise, or confirm.',
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
  return [previewAddToTreeToolDefinition, reviseTreePreviewToolDefinition, confirmAddToTreeToolDefinition];
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
  handlerMap.set(reviseTreePreviewToolDefinition.name, createReviseTreePreviewHandler({ includedTreeIds, principal, includeDebug }));
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
