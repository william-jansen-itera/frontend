export function buildLaneRequestContext(context, turnId) {
  return {
    conversationId: context.conversationId,
    turnId,
    expectedVersion: context.version,
  };
}

export function acceptLaneContext(current, payload) {
  const next = payload?.laneContext;
  if (!next) return current;
  if (next.conversationId !== current.conversationId ||
      !Number.isSafeInteger(next.version) || next.version < current.version) {
    throw new Error('The chat response has an invalid or outdated conversation context.');
  }
  return { conversationId: next.conversationId, version: next.version };
}
