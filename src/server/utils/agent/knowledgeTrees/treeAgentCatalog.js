import { randomUUID } from 'node:crypto';
import { DEFAULT_TOOL_TOP, searchTreeContent } from '@/server/utils/azureSearch';
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
  buildAgentSearchResult,
  buildDebugSearchResultSnapshot,
  buildTreeToolHandlerResult,
} from '@/server/utils/agent/knowledgeTrees/treeToolSearchResults';
import { buildAgentToolResult } from '@/server/utils/agent/agentToolResult';
import { assertTreeAccess } from '@/server/utils/tree/treeCatalog';
import { createLeafNodeFromChat, previewLeafFromChat } from '@/server/utils/tree/treeMutationService';
import {
  consumeTreePreviewSnapshot,
  storeTreePreviewSnapshot,
} from '@/server/utils/agent/knowledgeTrees/treePreviewSnapshotRepository';

export const KNOWLEDGE_TREES_FAMILY = 'knowledgeTrees';

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

function slugifyToolSegment(value, fallbackValue) {
  const normalizedValue = String(value || fallbackValue || 'tree')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);

  return normalizedValue || String(fallbackValue || 'tree');
}

function buildToolName(tree) {
  const suffix = slugifyToolSegment(tree.name, tree.id);
  return `search_tree_${suffix}_${tree.id}`;
}

function parseToolTreeId(toolName) {
  const match = String(toolName ?? '').trim().match(/_(\d+)$/);
  return match ? match[1] : '';
}

function normalizeToolTop(value) {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_TOOL_TOP;
  }

  return Math.min(parsedValue, DEFAULT_TOOL_TOP);
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

function buildToolDefinition(tree) {
  return {
    type: 'function',
    name: buildToolName(tree),
    description: tree.generatedToolDescription,
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: `Search phrase for the ${tree.name} tree.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };
}

function buildPersistenceToolDefinitions() {
  return [
    {
      type: 'function',
      name: 'preview_add_to_tree',
      description: 'Preview where a broader answer would be saved in a writable tree. Use only after the prior user-facing answer visibly offered to save it and the user explicitly accepted that offer; isPersistenceOffer=true alone is not permission. Call it directly once the user confirms. The output includes previewId, and the server caches the preview for a later confirm_add_to_tree call.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          toolName: {
            type: 'string',
            description: 'The specific dynamic search_tree_* tool that identifies the target tree for the new note. Do not substitute a tree name or any other label.',
          },
          originalQuestion: {
            type: 'string',
            description: 'The user question that led to the broader answer. This value is stored in the cached preview snapshot and later used during confirm_add_to_tree.',
          },
          broaderAnswer: {
            type: 'string',
            description: 'The broader answer cleaned and normalized into saveable tree-note content for the previewed note, while preserving detail needed for placement and note generation. This value is stored in the cached preview snapshot and later used during confirm_add_to_tree.',
          },
        },
        required: ['toolName', 'originalQuestion', 'broaderAnswer'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'confirm_add_to_tree',
      description: 'Create a new tree note after the user explicitly confirms the previewed save plan. The server uses the cached preview snapshot as the source of truth; if previewId is stale or missing, preview the save again. This is the only confirmation step after the preview. The output includes noteLink for the final reply.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          previewId: {
            type: 'string',
            description: 'The exact previewId returned by preview_add_to_tree. Pass only this id so the server can load the cached preview snapshot.',
          },
        },
        required: ['previewId'],
        additionalProperties: false,
      },
    },
  ];
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

function buildPersistenceToolHandlerResult({ toolName, toolResultType, toolOutput, includeDebug = false }) {
  const wrappedToolOutput = buildAgentToolResult({
    sourceToolFamily: KNOWLEDGE_TREES_FAMILY,
    toolName,
    toolResultType,
    data: toolOutput,
    meta: {
      resultCount: 1,
      supportsCitations: false,
      generatedAt: new Date().toISOString(),
    },
  });

  if (!includeDebug) {
    return {
      toolOutput: wrappedToolOutput,
    };
  }

  return {
    toolOutput: wrappedToolOutput,
    debug: {
      toolOutput: wrappedToolOutput,
    },
  };
}

async function assertWritableRuntimeTree({ treeId, principal }) {
  return assertTreeAccess(treeId, {
    principal,
    visibility: 'both',
    requireWriteAccess: true,
  });
}

function resolveRuntimeTreeId({ toolName, includedTreeIds }) {
  const treeId = parseToolTreeId(toolName);

  if (!treeId || !includedTreeIds.has(treeId)) {
    throw new Error('A valid writable tree tool context is required to save a broader answer.');
  }

  return treeId;
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

    handlerMap.set(toolName, async ({ query, top }) => {
      const normalizedQuery = String(query ?? '').trim();

      if (!normalizedQuery) {
        return buildTreeToolHandlerResult({
          sourceToolFamily: KNOWLEDGE_TREES_FAMILY,
          toolName,
          toolOutput: {
            count: 0,
            results: [],
          },
          searchResult: includeDebug
            ? {
              searches: [],
            }
            : null,
          includeDebug,
        });
      }

      const rawResult = await searchTreeContent({
        searchText: normalizedQuery,
        treeId: String(tree.id),
        top: normalizeToolTop(top),
        allowedTreeIds: [String(tree.id)],
        defaultTop: DEFAULT_TOOL_TOP,
        includeExecutedSearches: includeDebug,
        searchMode: 'any',
      });

      return buildTreeToolHandlerResult({
        sourceToolFamily: KNOWLEDGE_TREES_FAMILY,
        toolName,
        toolOutput: buildAgentSearchResult(rawResult),
        searchResult: includeDebug ? buildDebugSearchResultSnapshot(rawResult) : null,
        includeDebug,
      });
    });
  });

  handlerMap.set('preview_add_to_tree', async ({ toolName, originalQuestion, broaderAnswer }) => {
    const resolvedTreeId = resolveRuntimeTreeId({
      toolName,
      includedTreeIds,
    });

    await assertWritableRuntimeTree({
      treeId: resolvedTreeId,
      principal,
    });

    const preview = await previewLeafFromChat({
      treeInstanceId: Number.parseInt(resolvedTreeId, 10),
      originalQuestion,
      broaderAnswer,
    });

    const previewId = randomUUID();
    await storeTreePreviewSnapshot({
      previewId,
      preview,
      principal,
    });

    const previewWithId = {
      previewId,
      ...preview,
      toolName: 'preview_add_to_tree',
    };

    return buildPersistenceToolHandlerResult({
      toolName: 'preview_add_to_tree',
      toolResultType: 'tree_note_preview',
      toolOutput: previewWithId,
      includeDebug,
    });
  });

  handlerMap.set('confirm_add_to_tree', async ({ previewId }) => {
    if (!String(previewId ?? '').trim()) {
      throw new Error('A previewId from preview_add_to_tree is required to confirm saving the broader answer.');
    }

    const preview = await consumeTreePreviewSnapshot({
      previewId,
      principal,
    });
    const resolvedTreeId = String(preview?.treeId ?? '').trim();

    if (!includedTreeIds.has(resolvedTreeId)) {
      throw new Error('A valid writable tree id is required to save a broader answer.');
    }

    const writableTree = await assertWritableRuntimeTree({
      treeId: resolvedTreeId,
      principal,
    });

    const createdLeaf = await createLeafNodeFromChat({
      treeInstanceId: Number.parseInt(resolvedTreeId, 10),
      principal,
      toolName: 'confirm_add_to_tree',
      originalQuestion: preview.originalQuestion,
      broaderAnswer: preview.broaderAnswer,
      placementMode: preview.placementMode,
      selectedAnchorNodeId: preview.selectedAnchorNodeId,
      selectedAnchorBreadcrumb: preview.selectedAnchorBreadcrumb,
      generatedPathTitles: preview.generatedPathTitles,
      plannedLeafParentBreadcrumb: preview.plannedLeafParentBreadcrumb,
      generatedLeafTitle: preview.generatedLeafTitle,
    });
    const noteSearchParams = new URLSearchParams({
      treeId: String(createdLeaf.treeId),
      nodeId: String(createdLeaf.createdNodeId),
    });
    if (writableTree.isPrivate) {
      noteSearchParams.set('visibility', 'private');
    }

    const toolOutput = {
      ...createdLeaf,
      noteLink: `[View note](/notes?${noteSearchParams.toString()})`,
    };
    delete toolOutput.flatData;

    return buildPersistenceToolHandlerResult({
      toolName: 'confirm_add_to_tree',
      toolResultType: 'tree_note_created',
      toolOutput,
      includeDebug,
    });
  });

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
      ...selection.includedTrees.map((tree) => buildToolDefinition(tree)),
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

function buildTreeToolPreview(availableTrees) {
  return availableTrees.map((tree) => ({
    name: buildToolName(tree),
    description: tree.generatedToolDescription,
    treeId: tree.id ?? null,
    treeName: tree.name ?? null,
    descriptionSource: tree.descriptionSource ?? 'pending',
    includedInToolSet: Boolean(tree.includedInToolSet),
    aiInput: tree.aiInput ?? null,
    aiModelOutput: tree.aiModelOutput ?? null,
    aiGeneratedSummary: tree.aiGeneratedSummary ?? null,
    aiSelectedFocusTopics: tree.aiSelectedFocusTopics ?? [],
    generationFailureReason: tree.generationFailureReason ?? null,
  }));
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
