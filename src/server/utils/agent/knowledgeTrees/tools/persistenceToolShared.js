import { buildAgentToolResult } from '@/server/utils/agent/agentToolResult';
import { assertTreeAccess } from '@/server/utils/tree/treeCatalog';

export const KNOWLEDGE_TREES_FAMILY = 'knowledgeTrees';

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