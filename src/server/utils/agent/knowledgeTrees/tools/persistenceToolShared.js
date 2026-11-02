import { buildAgentToolResult } from '@/server/utils/agent/agentToolResult';
import { assertTreeAccess } from '@/server/utils/tree/treeCatalog';

export const KNOWLEDGE_TREES_FAMILY = 'knowledgeTrees';

export function buildTreePreviewToolOutput(previewId, preview) {
  const createPath = preview.mergeTarget && preview.createPath?.toLowerCase() === preview.mergeTarget.breadcrumb.toLowerCase()
    ? null
    : preview.createPath ?? null;
  const mergePath = preview.mergeTarget?.breadcrumb ?? null;

  return {
    previewId,
    treeName: preview.treeName,
    createPath,
    mergePath,
    defaultSaveMode: preview.defaultSaveMode,
    defaultSavePath: preview.defaultSaveMode === 'merge_existing' ? mergePath : createPath,
    differentPathSaveMode: 'create_leaf',
    availableSaveModes: preview.mergeTarget
      ? (!createPath
        ? ['merge_existing'] : ['merge_existing', 'create_leaf'])
      : ['create_leaf'],
  };
}

export function buildPersistenceToolHandlerResult({ toolName, toolResultType, toolOutput, includeDebug = false }) {
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
    return { toolOutput: wrappedToolOutput };
  }

  return {
    toolOutput: wrappedToolOutput,
    debug: { toolOutput: wrappedToolOutput },
  };
}

export async function assertWritableRuntimeTree({ treeId, principal }) {
  return assertTreeAccess(treeId, {
    principal,
    visibility: 'both',
    requireWriteAccess: true,
  });
}