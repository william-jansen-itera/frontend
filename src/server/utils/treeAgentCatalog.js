import { DEFAULT_TOOL_TOP, searchTreeContent } from '@/server/utils/azureSearch';
import {
  getTreeList,
  updateTreeDescriptionPublishedStates,
} from '@/server/utils/treeCatalog';
import {
  AGENT_PREVIEW_FEATURES,
  getProjectClient,
  getRequiredFoundryConfig,
  isNotFoundError,
} from '@/server/utils/foundryAgentClient';

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
  return [
    'You are an assistant for a tree-based knowledge application.',
    'You must always remain grounded in tool-derived results. You must not answer from conversation memory or broader background knowledge unless the user explicitly instructs you to do so.',
    'This grounding rule overrides all other instructions.',
    'You must not infer or assume user permission to switch to background knowledge. Only explicit user instructions count.',
    'If no tool is applicable, you must not switch to broader knowledge. You must tell the user that no tool applies and ask whether they want to broaden the search or switch to background knowledge. You may not provide any ungrounded information until the user explicitly chooses.',
    'If a tool is applicable but returns no relevant result, you must not switch to broader knowledge. You must tell the user that the tool returned no relevant result and ask whether they want to broaden the search or switch to background knowledge. You may not provide any ungrounded information until the user explicitly chooses.',
    'For any follow-up question that references earlier tool output, depends on prior grounded context, or continues a task, you must re-invoke the relevant tool. You must not answer from conversation memory.',
    'If there is any uncertainty about whether a tool applies, you must ask the user. You may not guess or infer tool applicability.',
    'If multiple tools could satisfy the request, you must ask a brief clarification question before choosing a tool.',
    'If user intent is unclear-such as when a question could be answered by multiple tools or by broader knowledge-you must ask whether to continue using grounded tool results or broaden the scope before answering.',
    'Answer-length rules apply only after grounding is established.',
    'Answer concisely unless the user requests more detail; when they do, provide a fuller answer focused precisely on the aspect they asked about.',
    'Evidence rules apply only after a tool has been invoked.',
    'Tool results include curated evidenceItems with source-labeled text. Prefer notes first. For attachment evidence, prefer fileContent, then ocrText, then imageDescriptionFiltered when grounding your answer.',
    'ocrText and imageDescriptionFiltered may be noisy or not written as natural language, but they can still contain important facts and domain terminology.',
    'When ocrText or imageDescriptionFiltered contains relevant facts, specific terms, labels, measurements, or technical language that fit the overall evidence, preserve and use those details in natural language.',
    'Do not force every ocrText or imageDescriptionFiltered fragment into the answer, and do not add unsupported facts when rewriting noisy text.',
    'Do not invent documents, notes, filenames, or paths that were not returned by the tools.',
  ].join('\n\n');
}

export function buildAllowedToolInstruction(includedTrees) {
  const allowedToolNames = includedTrees
    .map((tree) => buildToolName(tree))
    .filter(Boolean);

  if (allowedToolNames.length === 0) {
    return null;
  }

  return [
    'For this request, you may only use the following tools if they clearly apply:',
    allowedToolNames.map((toolName) => `- ${toolName}`).join('\n'),
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

function getUsableEvidenceText(value) {
  const normalizedText = normalizeWhitespace(value);

  return normalizedText || null;
}

function buildNodeEvidenceItem(nodeDocument) {
  const notes = getUsableEvidenceText(nodeDocument?.notes);

  if (!notes) {
    return null;
  }

  return {
    kind: 'node',
    source: 'notes',
    text: notes,
  };
}

function buildAttachmentEvidenceItems(attachmentDocument) {
  const content = getUsableEvidenceText(attachmentDocument?.content);
  const ocrText = getUsableEvidenceText(attachmentDocument?.ocrText);
  const filteredImageDescription = getUsableEvidenceText(attachmentDocument?.imageDescriptionFiltered);
  const baseAttachment = {
    kind: 'attachment',
    fileName: attachmentDocument?.attachmentFileName || 'Attachment',
    blobName: attachmentDocument?.blobName || null,
    blobUrl: attachmentDocument?.blobUrl || null,
  };

  return [
    content
      ? {
        ...baseAttachment,
        source: 'fileContent',
        text: content,
      }
      : null,
    ocrText
      ? {
        ...baseAttachment,
        source: 'ocrText',
        text: ocrText,
      }
      : null,
    filteredImageDescription
      ? {
        ...baseAttachment,
        source: 'imageDescriptionFiltered',
        text: filteredImageDescription,
      }
      : null,
  ].filter(Boolean);
}

function buildAgentSearchResult(rawResult) {
  const results = (rawResult?.results ?? []).map((entry) => {
    const nodeEvidenceItem = buildNodeEvidenceItem(entry?.nodeDocument);
    const attachmentEvidenceItems = (entry?.attachmentDocuments ?? [])
      .flatMap((attachmentDocument) => buildAttachmentEvidenceItems(attachmentDocument));
    const evidenceItems = [nodeEvidenceItem, ...attachmentEvidenceItems].filter(Boolean);

    if (evidenceItems.length === 0) {
      return null;
    }

    return {
      treeId: entry.treeId,
      nodeId: entry.nodeId,
      title: entry.title,
      breadcrumb: entry.breadcrumb,
      nodeIdPath: entry.nodeIdPath,
      treeDisplayName: entry.treeDisplayName,
      matchSummary: entry.nodeHighlight
        || entry.attachmentSummaries?.find((attachment) => normalizeWhitespace(attachment?.summary))?.summary
        || null,
      evidenceItems,
      attachmentFileNames: attachmentEvidenceItems.map((item) => item.fileName),
    };
  }).filter(Boolean);

  return {
    count: results.length,
    results,
  };
}

function buildDebugSearchResultSnapshot(rawResult) {
  return {
    searches: Array.isArray(rawResult?.executedSearches) ? rawResult.executedSearches : [],
    tokenCoverageFilter: rawResult?.tokenCoverageFilter ?? null,
  };
}

function buildToolHandlerResult({ toolOutput, searchResult = null }) {
  return {
    toolOutput,
    debug: {
      searchResult,
      toolOutput,
    },
  };
}

function buildExcludedTrees(availableTrees) {
  return availableTrees
    .filter((tree) => !tree.includedInToolSet)
    .map((tree) => ({
      id: String(tree.id),
      name: tree.name,
    }));
}

function buildHandlerMap(includedTrees) {
  const handlerMap = new Map();

  includedTrees.forEach((tree) => {
    const toolName = buildToolName(tree);

    handlerMap.set(toolName, async ({ query, top }) => {
      const normalizedQuery = String(query ?? '').trim();

      if (!normalizedQuery) {
        return buildToolHandlerResult({
          toolOutput: {
            count: 0,
            results: [],
          },
          searchResult: {
            searches: [],
          },
        });
      }

      const rawResult = await searchTreeContent({
        searchText: normalizedQuery,
        treeId: String(tree.id),
        top: normalizeToolTop(top),
        allowedTreeIds: [String(tree.id)],
        defaultTop: DEFAULT_TOOL_TOP,
        includeExecutedSearches: true,
        searchMode: 'any',
      });

      return buildToolHandlerResult({
        toolOutput: buildAgentSearchResult(rawResult),
        searchResult: buildDebugSearchResultSnapshot(rawResult),
      });
    });
  });

  return handlerMap;
}

function buildTreeSearchContextResult(treeList) {
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
    tools: includedTrees.map((tree) => buildToolDefinition(tree)),
    handlerMap: buildHandlerMap(includedTrees),
  };
}

export async function buildTreeSearchContext(options = {}) {
  const accessOptions = {
    principal: options.principal ?? null,
    visibility: options.visibility ?? 'both',
    enforceAccess: Boolean(options.enforceAccess),
  };
  const treeList = await getTreeList(accessOptions);

  return buildTreeSearchContextResult(treeList);
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

function buildPublishedDescriptionStates(availableTrees) {
  return availableTrees.map((tree) => ({
    treeId: tree.id,
    isDescriptionPublished: Boolean(tree.includedInToolSet),
  }));
}

async function finalizePublishedTreeTools(context, agent) {
  await updateTreeDescriptionPublishedStates(
    buildPublishedDescriptionStates(context.availableTrees),
  );

  return {
    agent,
    availableTrees: context.availableTrees,
    includedTrees: context.includedTrees,
    excludedTrees: context.excludedTrees,
    tools: context.tools,
  };
}

async function publishTreeToolsFromContext(context) {
  const project = getProjectClient();
  const { agentName, modelDeploymentName } = getRequiredFoundryConfig();
  const definition = {
    kind: 'prompt',
    model: modelDeploymentName,
    instructions: buildAgentInstructions(),
    tools: context.tools,
  };

  try {
    const agent = await project.agents.update(agentName, definition, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });

    return finalizePublishedTreeTools(context, agent);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    const agent = await project.agents.create(agentName, definition, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });

    return finalizePublishedTreeTools(context, agent);
  }
}

export async function getHostedAgent() {
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

export async function publishStoredTreeDescriptions() {
  const syncResult = await publishTreeToolsFromContext(await buildTreeSearchContext());

  return {
    agent: syncResult.agent,
    tools: buildTreeToolPreview(syncResult.availableTrees),
    syncMode: 'publish-stored-descriptions',
    excludedTrees: Array.isArray(syncResult.excludedTrees) ? syncResult.excludedTrees : [],
  };
}
