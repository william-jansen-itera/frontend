const TOOL_RESULT_SCHEMA_VERSION = '1';

function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return {};
  }

  return { ...meta };
}

export function buildAgentToolResult({
  sourceToolFamily,
  toolName,
  toolResultType,
  data,
  meta = {},
  debug,
}) {
  return {
    schemaVersion: TOOL_RESULT_SCHEMA_VERSION,
    sourceToolFamily: String(sourceToolFamily ?? '').trim(),
    toolName: String(toolName ?? '').trim(),
    toolResultType: String(toolResultType ?? '').trim(),
    data,
    meta: normalizeMeta(meta),
    ...(debug === undefined ? {} : { debug }),
  };
}

export function isAgentToolResult(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && typeof value.schemaVersion === 'string'
      && typeof value.sourceToolFamily === 'string'
      && typeof value.toolName === 'string'
      && typeof value.toolResultType === 'string'
      && 'data' in value
      && 'meta' in value,
  );
}

export function getAgentToolResultData(result) {
  return isAgentToolResult(result) ? result.data : result;
}

export function getAgentToolResultMeta(result) {
  return isAgentToolResult(result) ? result.meta : {};
}

export function getAgentToolResultDebug(result) {
  return isAgentToolResult(result) ? (result.debug ?? null) : null;
}
