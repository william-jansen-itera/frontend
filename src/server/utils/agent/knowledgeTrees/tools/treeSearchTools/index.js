import { DEFAULT_TOOL_TOP, searchTreeContent } from '@/server/utils/azureSearch';
import {
  buildAgentSearchResult,
  buildDebugSearchResultSnapshot,
  buildTreeToolHandlerResult,
} from '@/server/utils/agent/knowledgeTrees/tools/treeSearchTools/treeToolSearchResults';

function slugifyToolSegment(value, fallbackValue) {
  const normalizedValue = String(value || fallbackValue || 'tree')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);

  return normalizedValue || String(fallbackValue || 'tree');
}

export function buildToolName(tree) {
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

export function buildTreeSearchToolDefinition(tree) {
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

export function createTreeSearchToolHandler(tree, { sourceToolFamily, includeDebug = false } = {}) {
  const toolName = buildToolName(tree);

  return async ({ query, top }) => {
    const normalizedQuery = String(query ?? '').trim();

    if (!normalizedQuery) {
      return buildTreeToolHandlerResult({
        sourceToolFamily,
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
      sourceToolFamily,
      toolName,
      toolOutput: buildAgentSearchResult(rawResult),
      searchResult: includeDebug ? buildDebugSearchResultSnapshot(rawResult) : null,
      includeDebug,
    });
  };
}

export function buildTreeToolPreview(availableTrees) {
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