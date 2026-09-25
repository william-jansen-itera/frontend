const FAMILY_RESULT_SCHEMA_VERSION = '1';

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function buildAgentFamilyResult({
  sourceToolFamily,
  turnType,
  answer,
  toolsUsed,
  citations,
  followUpOptions,
  familyPayload,
  debug,
}) {
  return {
    schemaVersion: FAMILY_RESULT_SCHEMA_VERSION,
    sourceToolFamily: String(sourceToolFamily ?? '').trim(),
    turnType: String(turnType ?? '').trim(),
    answer: String(answer ?? ''),
    toolsUsed: normalizeStringArray(toolsUsed),
    ...(Array.isArray(citations) ? { citations: normalizeArray(citations) } : {}),
    ...(Array.isArray(followUpOptions) ? { followUpOptions: normalizeArray(followUpOptions) } : {}),
    ...(familyPayload === undefined ? {} : { familyPayload }),
    ...(debug === undefined ? {} : { debug }),
  };
}

export function isAgentFamilyResult(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && typeof value.schemaVersion === 'string'
      && typeof value.sourceToolFamily === 'string'
      && typeof value.turnType === 'string'
      && typeof value.answer === 'string'
      && Array.isArray(value.toolsUsed),
  );
}
