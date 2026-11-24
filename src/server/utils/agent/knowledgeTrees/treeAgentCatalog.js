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
import { createProcessUploadHandler, processUploadToolDefinition } from '@/server/utils/agent/knowledgeTrees/tools/processUploadTool';
import { KNOWLEDGE_TREES_FAMILY } from '@/server/utils/agent/knowledgeTrees/tools/persistenceToolShared';
import { buildTreeAgentInstructions as buildAgentInstructions } from './instructions/index.js';
import { switchTreeLaneToolDefinition } from './tools/switchTreeLaneTool/index.js';

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



export function buildAllowedToolInstruction(includedTrees) {
  const allowedToolNames = includedTrees
    .map((tree) => buildToolName(tree))
    .filter(Boolean);

  if (allowedToolNames.length === 0) {
    return null;
  }

  return [
    'Available tree search tools for this request:',
    allowedToolNames.map((toolName) => `- ${toolName}`).join('\n'),
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
  return [previewAddToTreeToolDefinition, reviseTreePreviewToolDefinition, confirmAddToTreeToolDefinition, switchTreeLaneToolDefinition];
}

function buildPersistenceToolPreview() {
  return [...buildPersistenceToolDefinitions(), processUploadToolDefinition].map((tool) => ({
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

function buildHandlerMap(includedTrees, { includeDebug = false, principal = null, currentUserMessage = '', currentUploadId = null, previewUploadId = null, pendingUploadId = null } = {}) {
  const handlerMap = new Map();
  const includedTreeIds = new Set(includedTrees.map((tree) => String(tree.id)));

  includedTrees.forEach((tree) => {
    const toolName = buildToolName(tree);
    handlerMap.set(toolName, createTreeSearchToolHandler(tree, {
      sourceToolFamily: KNOWLEDGE_TREES_FAMILY,
      includeDebug,
    }));
  });

  handlerMap.set(previewAddToTreeToolDefinition.name, createPreviewAddToTreeHandler({ includedTrees, principal, includeDebug, currentUserMessage, currentUploadId, previewUploadId, pendingUploadId }));
  handlerMap.set(reviseTreePreviewToolDefinition.name, createReviseTreePreviewHandler({ includedTreeIds, principal, includeDebug }));
  handlerMap.set(confirmAddToTreeToolDefinition.name, createConfirmAddToTreeHandler({ includedTreeIds, principal, includeDebug }));
  handlerMap.set(processUploadToolDefinition.name, createProcessUploadHandler({ principal, currentUploadId }));

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
      processUploadToolDefinition,
    ],
  };
}

export async function buildRuntimeTreeToolContext(options = {}) {
  const selection = await loadTreeSelection(options);
  const handlerMap = buildHandlerMap(selection.includedTrees, {
    includeDebug: Boolean(options.includeDebug),
    principal: options.principal ?? null,
    currentUserMessage: options.currentUserMessage ?? '',
    currentUploadId: options.currentUploadId ?? null,
    previewUploadId: options.previewUploadId ?? null,
    pendingUploadId: options.pendingUploadId ?? null,
  });

  return {
    includedTrees: selection.includedTrees,
    handlerMap,
    toolPolicies: new Map([
      ...selection.includedTrees.map((tree) => [buildToolName(tree), { requiresUserApproval: false }]),
      [previewAddToTreeToolDefinition.name, { requiresUserApproval: false }],
      [reviseTreePreviewToolDefinition.name, { requiresUserApproval: false }],
      [confirmAddToTreeToolDefinition.name, { requiresUserApproval: false }],
      [processUploadToolDefinition.name, { requiresUserApproval: false }],
      [switchTreeLaneToolDefinition.name, { requiresUserApproval: false }],
    ]),
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
  const { agentName, modelDeploymentName, reasoning } = getRequiredFoundryConfig();
  const definition = {
    kind: 'prompt',
    model: modelDeploymentName,
    ...(reasoning ? { reasoning } : {}),
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
