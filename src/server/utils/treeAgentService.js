import { getProjectClient } from '@/server/utils/foundryAgentClient';
import {
  buildAllowedToolInstruction,
  buildTreeSearchContext,
  getHostedAgent,
} from '@/server/utils/treeAgentCatalog';
import {
  attachDebugToError,
  buildAgentResult,
  buildInitialAgentInput,
  createAgentDebugState,
  normalizeFollowUpSelection,
  serializeDebugValue,
  shapeTreeAgentTurn,
} from '@/server/utils/treeAgentTurnShaper';

const DEFAULT_HISTORY_LIMIT = 8;
const MAX_TOOL_ROUNDS = 5;

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .slice(-DEFAULT_HISTORY_LIMIT)
    .map((entry) => {
      const role = entry?.role === 'assistant' ? 'assistant' : 'user';
      const content = String(entry?.content ?? '').trim();

      if (!content) {
        return null;
      }

      return {
        type: 'message',
        role,
        content,
      };
    })
    .filter(Boolean);
}

function normalizeToolHandlerResult(result, includeDebug = false) {
  if (result && typeof result === 'object' && 'toolOutput' in result) {
    return {
      toolOutput: result.toolOutput,
      debug: includeDebug ? (result.debug ?? null) : null,
    };
  }

  return {
    toolOutput: result,
    debug: includeDebug
      ? {
        searchResult: null,
        toolOutput: result,
      }
      : null,
  };
}

async function createAgentResponse(openAIClient, agentName, payload) {
  return openAIClient.responses.create(payload, {
    body: {
      agent: {
        name: agentName,
        type: 'agent_reference',
      },
    },
  });
}

// runs the tools stated in initialresponse,
// and synthesizes the results through an agent call
// and if synthesis contains no further tool calls, the loop terminates.
// the previous_response_id is used to maintain context across tool rounds,
// however, there is usually only one tool round as it is
async function runToolLoop({ response, openAIClient, agentName, handlerMap, debugRounds = null, includeDebug = false }) {
  const toolInvocations = [];
  const modelCalls = [];
  let currentResponse = response;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const functionCalls = Array.isArray(currentResponse?.output)
      ? currentResponse.output.filter((item) => item?.type === 'function_call')
      : [];

    if (functionCalls.length === 0) {
      return {
        response: currentResponse,
        toolInvocations,
        modelCalls,
      };
    }

    const functionOutputs = [];
    const roundDebug = includeDebug ? [] : null;

    for (const functionCall of functionCalls) {
      const toolName = functionCall.name;
      const handler = handlerMap.get(toolName);
      const toolStartedAt = new Date().toISOString();
      const toolStartedAtMs = Date.now();
      let parsedArguments = null;
      let output;
      let toolDebug = {
        searchResult: null,
        toolOutput: null,
      };
      let executionError = null;

      try {
        parsedArguments = JSON.parse(functionCall.arguments || '{}');

        if (!handler) {
          output = {
            error: `No handler is registered for tool ${toolName}.`,
          };
        } else {
          const handlerResult = normalizeToolHandlerResult(await handler(parsedArguments), includeDebug);
          output = handlerResult.toolOutput;
          toolDebug = handlerResult.debug;
        }
      } catch (error) {
        executionError = error instanceof Error ? error.message : 'Tool execution failed';
        output = {
          error: executionError,
        };
      }

      const functionCallOutput = {
        type: 'function_call_output',
        call_id: functionCall.call_id,
        output: JSON.stringify(output),
      };

      toolInvocations.push({
        toolName,
        arguments: functionCall.arguments || '{}',
        output,
      });
      if (roundDebug) {
        roundDebug.push({
          round: round + 1,
          callId: functionCall.call_id ?? null,
          toolName,
          startedAt: toolStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - toolStartedAtMs,
          parsedArguments: serializeDebugValue(parsedArguments),
          searchResult: serializeDebugValue(toolDebug?.searchResult),
          toolOutput: serializeDebugValue(output),
          agentToolInput: serializeDebugValue(functionCallOutput),
          error: executionError,
        });
      }
      functionOutputs.push(functionCallOutput);
    }

    const modelCallStartedAt = new Date().toISOString();
    const modelCallStartedAtMs = Date.now();
    currentResponse = await createAgentResponse(openAIClient, agentName, {
      input: functionOutputs,
      previous_response_id: currentResponse.id,
    });
    if (includeDebug) {
      modelCalls.push({
        phase: 'tool_round_synthesis',
        round: round + 1,
        startedAt: modelCallStartedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - modelCallStartedAtMs,
        responseId: currentResponse?.id ?? null,
        status: currentResponse?.status ?? null,
      });
      debugRounds.push(...roundDebug);
    }
  }

  throw new Error('The agent exceeded the maximum number of tool rounds');
}

// runs initial agent invocation
// starts the tool loop
// and classifies the turn type (eg. default, no_result_offer_broadening, broader_answer)
export async function invokeTreeSearchAgent({ message, history = [], principal = null, visibility = 'public', followUpSelection = null, includeDebug = false }) {
  const normalizedFollowUpSelection = normalizeFollowUpSelection(followUpSelection);
  const normalizedMessage = String(message ?? '').trim();

  if (!normalizedMessage) {
    throw new Error('A message is required to invoke the agent');
  }

  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const agent = await getHostedAgent();
  const { handlerMap, includedTrees } = await buildTreeSearchContext({
    principal,
    visibility,
    enforceAccess: true,
    includeDebug,
  });
  const normalizedHistory = normalizeHistory(history);
  const allowedToolInstruction = buildAllowedToolInstruction(includedTrees);
  const initialInput = buildInitialAgentInput({
    allowedToolInstruction,
    normalizedHistory,
    normalizedMessage,
  });
  const debug = includeDebug
    ? createAgentDebugState({
      normalizedMessage,
      normalizedFollowUpSelection,
      initialInput,
    })
    : null;
  const requestStartedAtMs = includeDebug ? Date.now() : null;

  try {
    const initialModelCallStartedAt = new Date().toISOString();
    const initialModelCallStartedAtMs = Date.now();
    const initialResponse = await createAgentResponse(openAIClient, agent.name, {
      input: initialInput,
    });
    if (debug) {
      debug.timings.modelCalls.push({
        phase: 'initial_response',
        round: 0,
        startedAt: initialModelCallStartedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - initialModelCallStartedAtMs,
        responseId: initialResponse?.id ?? null,
        status: initialResponse?.status ?? null,
      });
    }

    const { response, toolInvocations, modelCalls } = await runToolLoop({
      response: initialResponse,
      openAIClient,
      agentName: agent.name,
      handlerMap,
      debugRounds: debug?.toolCalls ?? null,
      includeDebug,
    });
    if (debug) {
      debug.timings.modelCalls.push(...modelCalls);
    }
    const { answer, citations, shapedResponse } = await shapeTreeAgentTurn({
      finalResponse: response,
      finalToolInvocations: [...toolInvocations],
      normalizedFollowUpSelection,
      openAIClient,
      normalizedMessage,
      debug,
      agent,
    });
    if (debug) {
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }

    return buildAgentResult({ answer, agent, shapedResponse, citations, principal, debug });
  } catch (error) {
    if (debug) {
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }
    throw attachDebugToError(error, debug);
  }
}