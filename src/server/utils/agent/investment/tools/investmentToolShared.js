import { buildAgentToolResult } from '@/server/utils/agent/agentToolResult';

const INVESTMENT_FAMILY = 'investment';

export function normalizeTicker(value) {
  return String(value ?? '').trim().toUpperCase();
}

export function buildInvestmentToolResult({ toolName, toolResultType, data, includeDebug = false, debug = null }) {
  return buildAgentToolResult({
    sourceToolFamily: INVESTMENT_FAMILY,
    toolName,
    toolResultType,
    data,
    meta: {
      resultCount: Array.isArray(data?.priceHistory)
        ? data.priceHistory.length
        : Array.isArray(data?.signals)
          ? data.signals.length
          : 1,
      supportsCitations: false,
      generatedAt: new Date().toISOString(),
    },
    ...(includeDebug ? { debug } : {}),
  });
}