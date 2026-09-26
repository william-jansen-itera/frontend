export function serializeDebugValue(value) {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {
      serializationError: 'Value could not be serialized for debug output.',
      valueType: typeof value,
      stringValue: String(value),
    };
  }
}

export function createDebugTimingEntry(overrides = {}) {
  return {
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

function buildPhaseTimingMap(phaseNames = []) {
  return phaseNames.reduce((accumulator, phaseName) => {
    accumulator[phaseName] = createDebugTimingEntry();
    return accumulator;
  }, {});
}

export function createAgentDebugState({
  sourceToolFamily,
  normalizedMessage,
  normalizedFollowUpSelection,
  initialInput,
  phaseNames = [],
  extraTimings = {},
}) {
  return {
    sourceToolFamily,
    orchestration: {
      activeFamily: sourceToolFamily,
      familyStack: [sourceToolFamily],
      orchestratorSteps: [],
    },
    userQuery: {
      message: normalizedMessage,
      followUpSelection: serializeDebugValue(normalizedFollowUpSelection),
    },
    toolCalls: [],
    curatedAgentInput: {
      initialMessages: serializeDebugValue(initialInput),
      toolMessages: [],
    },
    family: null,
    agentOutput: null,
    timings: {
      requestStartedAt: new Date().toISOString(),
      requestCompletedAt: null,
      totalDurationMs: null,
      modelCalls: [],
      ...extraTimings,
      phases: buildPhaseTimingMap(phaseNames),
    },
  };
}

export async function captureTimingEntry(timingEntry, action) {
  if (!timingEntry) {
    return action();
  }

  timingEntry.startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  try {
    return await action();
  } finally {
    timingEntry.completedAt = new Date().toISOString();
    timingEntry.durationMs = Date.now() - startedAtMs;
  }
}

export function attachDebugToError(error, debug) {
  if (!debug) {
    if (error instanceof Error) {
      return error;
    }

    return new Error(String(error ?? 'Agent request failed'));
  }

  const normalizedDebug = serializeDebugValue(debug);

  if (error instanceof Error) {
    error.debug = normalizedDebug;
    return error;
  }

  const wrappedError = new Error(String(error ?? 'Agent request failed'));
  wrappedError.debug = normalizedDebug;
  return wrappedError;
}

export function buildResponseDebugSnapshot(response) {
  return serializeDebugValue({
    id: response?.id ?? null,
    status: response?.status ?? null,
    usage: response?.usage ?? null,
    error: response?.error ?? null,
    incomplete_details: response?.incomplete_details ?? null,
  });
}

export function setCuratedToolMessages(debug) {
  if (!debug) {
    return;
  }

  debug.curatedAgentInput.toolMessages = serializeDebugValue(
    debug.toolCalls.map((toolCall) => ({
      type: 'function_call_output',
      call_id: toolCall.callId ?? null,
      output: `See 4. Tool Calls > Tool output for round ${toolCall.round}${toolCall.toolName ? ` (${toolCall.toolName})` : ''}.`,
    })),
  );
}

export function buildAgentOutputDebug({ agent, response, answer, extra = {} }) {
  return {
    agent: agent
      ? {
        id: agent.id ?? null,
        name: agent.name ?? null,
        version: agent.version ?? null,
      }
      : null,
    response: buildResponseDebugSnapshot(response),
    answer,
    error: response?.error ?? null,
    ...extra,
  };
}

export function buildFamilyDebugPayload(debug) {
  if (!debug) {
    return undefined;
  }

  return serializeDebugValue({
    sourceToolFamily: debug.sourceToolFamily ?? null,
    orchestration: debug.orchestration ?? null,
    userQuery: debug.userQuery ?? null,
    toolCalls: debug.toolCalls ?? [],
    curatedAgentInput: debug.curatedAgentInput ?? null,
    turnClassification: debug.turnClassification ?? null,
    family: debug.family ?? null,
    agentOutput: debug.agentOutput ?? null,
    timings: debug.timings ?? null,
  });
}
