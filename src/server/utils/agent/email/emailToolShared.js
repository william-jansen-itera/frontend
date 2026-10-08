import { buildAgentToolResult } from '@/server/utils/agent/agentToolResult';

export const EMAIL_FAMILY = 'email';

function resolveResultCount(data) {
  if (Array.isArray(data?.emails)) {
    return data.emails.length;
  }

  if (Array.isArray(data?.messages)) {
    return data.messages.length;
  }

  if (Array.isArray(data?.summaries)) {
    return data.summaries.length;
  }

  if (Array.isArray(data?.classifications)) {
    return data.classifications.length;
  }

  if (Array.isArray(data?.analyses)) {
    return data.analyses.length;
  }

  if (Array.isArray(data?.actionItems)) {
    return data.actionItems.length;
  }

  return 1;
}

export function buildEmailToolResult({ toolName, toolResultType, data, includeDebug = false, debug = null }) {
  return buildAgentToolResult({
    sourceToolFamily: EMAIL_FAMILY,
    toolName,
    toolResultType,
    data,
    meta: {
      resultCount: resolveResultCount(data),
      generatedAt: new Date().toISOString(),
    },
    ...(includeDebug ? { debug } : {}),
  });
}