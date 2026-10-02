import { performance } from 'node:perf_hooks';
import { getAgentToolResultData, getAgentToolResultDebug, getAgentToolResultMeta, isAgentToolResult } from '@/server/utils/agent/agentToolResult';
import { appendDebugStep } from '@/server/utils/agent/agentDebug';

const MAX_TOOL_ROUNDS = 5;

function getElapsedDurationMs(startedAtMs) {
  const elapsedMs = performance.now() - startedAtMs;

  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return 0;
  }

  return Number(elapsedMs.toFixed(1));
}

function getToolOutputMetaData(result) {
  if (!isAgentToolResult(result)) {
    return null;
  }

  return {
    schemaVersion: result.schemaVersion,
    sourceToolFamily: result.sourceToolFamily,
    toolName: result.toolName,
    toolResultType: result.toolResultType,
    meta: getAgentToolResultMeta(result),
  };
}

function buildModelFacingToolOutput(result) {
  const toolData = getAgentToolResultData(result);

  if (isAgentToolResult(result)) {
    return {
      ...result,
      data: toolData,
    };
  }

  return toolData;
}

function normalizeToolHandlerResult(result, includeDebug = false) {
  if (isAgentToolResult(result)) {
    return {
      toolOutput: result,
      debug: includeDebug ? (getAgentToolResultDebug(result) ?? null) : null,
    };
  }

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

async function createAgentResponse(openAIClient, responseConfig, payload) {
  if (responseConfig?.type === 'agent_reference') {
    return openAIClient.responses.create(payload, {
      body: {
        agent: {
          name: responseConfig.agentName,
          type: 'agent_reference',
        },
      },
    });
  }

  if (responseConfig?.type === 'direct_model') {
    return openAIClient.responses.create({
      ...payload,
      model: responseConfig.model,
      instructions: responseConfig.instructions,
      tools: responseConfig.tools,
    });
  }

  throw new Error('Unsupported family response configuration');
}

export async function runAgentFamilyExecution({
  openAIClient,
  responseConfig,
  initialInput,
  handlerMap,
  handlerContext = null,
  debug = null,
  includeDebug = false,
}) {
  const modelCalls = [];
  const toolInvocations = [];

  const initialModelCallStartedAt = new Date().toISOString();
  const initialModelCallStartedAtMs = performance.now();
  appendDebugStep(debug, 'initial model response requested');
  let currentResponse = await createAgentResponse(openAIClient, responseConfig, {
    input: initialInput,
  });
  appendDebugStep(debug, 'initial model response received', {
    responseId: currentResponse?.id ?? null,
    status: currentResponse?.status ?? null,
  });

  if (debug) {
    debug.timings.modelCalls.push({
      phase: 'initial_response',
      round: 0,
      startedAt: initialModelCallStartedAt,
      completedAt: new Date().toISOString(),
      durationMs: getElapsedDurationMs(initialModelCallStartedAtMs),
      responseId: currentResponse?.id ?? null,
      status: currentResponse?.status ?? null,
    });
  }

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
    appendDebugStep(debug, `tool round ${round + 1} started`, {
      functionCallCount: functionCalls.length,
    });

    for (const functionCall of functionCalls) {
      const toolName = functionCall.name;
      const handler = handlerMap.get(toolName);
      const toolStartedAt = new Date().toISOString();
      const toolStartedAtMs = performance.now();
      let parsedArguments = null;
      let output;
      let toolDebug = {
        searchResult: null,
        toolOutput: null,
      };
      let executionError = null;
      let executionErrorDetails = null;

      try {
        parsedArguments = JSON.parse(functionCall.arguments || '{}');
        appendDebugStep(debug, `tool ${toolName} called`, {
          round: round + 1,
          callId: functionCall.call_id ?? null,
        });

        if (!handler) {
          output = {
            error: `No handler is registered for tool ${toolName}.`,
          };
          appendDebugStep(debug, `tool ${toolName} missing handler`, {
            round: round + 1,
            callId: functionCall.call_id ?? null,
          });
        } else {
          const handlerResult = normalizeToolHandlerResult(await handler(parsedArguments, handlerContext), includeDebug);
          output = handlerResult.toolOutput;
          toolDebug = handlerResult.debug;
          appendDebugStep(debug, `tool ${toolName} completed`, {
            round: round + 1,
            callId: functionCall.call_id ?? null,
            durationMs: getElapsedDurationMs(toolStartedAtMs),
          });
        }
      } catch (error) {
        executionError = error instanceof Error ? error.message : 'Tool execution failed';
        executionErrorDetails = {
          message: error instanceof Error ? error.message : 'Tool execution failed',
          name: error instanceof Error ? error.name : null,
          stack: error instanceof Error ? error.stack ?? null : null,
          debug: error?.debug ?? null,
        };
        if (executionErrorDetails.debug && includeDebug) {
          toolDebug = {
            ...toolDebug,
            ...(executionErrorDetails.debug && typeof executionErrorDetails.debug === 'object'
              ? executionErrorDetails.debug
              : { errorDebug: executionErrorDetails.debug }),
          };
        }
        output = {
          error: executionError,
        };
        appendDebugStep(debug, `tool ${toolName} failed`, {
          round: round + 1,
          callId: functionCall.call_id ?? null,
          errorMessage: executionError,
        });
      }

      const modelFacingOutput = buildModelFacingToolOutput(output);

      const functionCallOutput = {
        type: 'function_call_output',
        call_id: functionCall.call_id,
        output: JSON.stringify(modelFacingOutput),
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
          durationMs: getElapsedDurationMs(toolStartedAtMs),
          parsedArguments: parsedArguments,
          searchResult: toolDebug?.searchResult ?? null,
          toolDebug: toolDebug,
          toolMetaData: getToolOutputMetaData(output),
          toolOutput: getAgentToolResultData(output),
          agentToolInput: functionCallOutput,
          error: executionErrorDetails ?? executionError,
        });
      }
      functionOutputs.push(functionCallOutput);
    }

    const modelCallStartedAt = new Date().toISOString();
    const modelCallStartedAtMs = performance.now();
    appendDebugStep(debug, `tool round ${round + 1} synthesis requested`, {
      functionOutputCount: functionOutputs.length,
    });
    currentResponse = await createAgentResponse(openAIClient, responseConfig, {
      input: functionOutputs,
      previous_response_id: currentResponse.id,
    });
    appendDebugStep(debug, `tool round ${round + 1} synthesis received`, {
      responseId: currentResponse?.id ?? null,
      status: currentResponse?.status ?? null,
    });
    if (includeDebug) {
      modelCalls.push({
        phase: 'tool_round_synthesis',
        round: round + 1,
        startedAt: modelCallStartedAt,
        completedAt: new Date().toISOString(),
        durationMs: getElapsedDurationMs(modelCallStartedAtMs),
        responseId: currentResponse?.id ?? null,
        status: currentResponse?.status ?? null,
      });
      debug?.toolCalls?.push(...roundDebug);
    }
  }

  appendDebugStep(debug, 'agent family execution exceeded tool round limit');
  throw new Error('The agent exceeded the maximum number of tool rounds');
}
