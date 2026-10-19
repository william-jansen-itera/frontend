import { serializeDebugValue } from '@/server/utils/agent/agentDebug';
import {
  parseStructuredAnswerStateResponse,
} from '@/server/utils/agent/agentAnswerState';
import {
  getAgentToolResultData,
  getAgentToolResultMeta,
} from '@/server/utils/agent/agentToolResult';

export const KNOWLEDGE_MODE_GROUNDED = 'grounded';
export const KNOWLEDGE_MODE_BROAD = 'broad';

function extractAnswerText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const textOutput = Array.isArray(response?.output)
    ? response.output.find((item) => item?.type === 'message' && Array.isArray(item.content))
    : null;

  if (!textOutput) {
    return '';
  }

  return textOutput.content
    .filter((item) => item?.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

function getToolInvocationResultCount(invocation) {
  const metaResultCount = Number(getAgentToolResultMeta(invocation?.output)?.resultCount);

  if (Number.isFinite(metaResultCount)) {
    return metaResultCount;
  }

  const toolData = getAgentToolResultData(invocation?.output);

  if (Number.isFinite(Number(toolData?.count))) {
    return Number(toolData.count);
  }

  if (Array.isArray(toolData?.priceHistory)) {
    return toolData.priceHistory.length;
  }

  return toolData ? 1 : 0;
}

function buildResponseToolInvocations(toolInvocations) {
  return toolInvocations
    .map((invocation) => ({
      toolName: invocation.toolName,
      arguments: invocation.arguments,
      resultCount: getToolInvocationResultCount(invocation),
    }));
}

export function readAgentTurnState({
  finalResponse,
  finalToolInvocations,
  requireReportedAnswerState = true,
  answerStateOptions = undefined,
  debug = null,
}) {
  const structuredAnswerState = (() => {
    try {
      return parseStructuredAnswerStateResponse(finalResponse, answerStateOptions);
    } catch {
      return null;
    }
  })();
  const answer = structuredAnswerState?.answer ?? extractAnswerText(finalResponse);
  const responseToolInvocations = buildResponseToolInvocations(finalToolInvocations);

  if (!structuredAnswerState && requireReportedAnswerState) {
    throw new Error('The agent did not return a valid answer state.');
  }

  const knowledgeMode = structuredAnswerState?.knowledgeMode ?? null;
  const isPermissionToBroadenRequest = structuredAnswerState?.isPermissionToBroadenRequest === true;
  const isPersistenceOffer = structuredAnswerState?.isPersistenceOffer === true;
  const answerStateExplanation = String(structuredAnswerState?.explanation ?? '').trim() || null;
  const usedBroaderKnowledge = knowledgeMode === KNOWLEDGE_MODE_BROAD;
  const isGrounded = !usedBroaderKnowledge;

  if (debug) {
    debug.turnClassification = serializeDebugValue({
      knowledgeMode,
      isPermissionToBroadenRequest,
      isPersistenceOffer,
      explanation: answerStateExplanation,
      responseToolInvocations,
    });
  }

  return {
    answer,
    knowledgeMode,
    isGrounded,
    usedBroaderKnowledge,
    isPermissionToBroadenRequest,
    isPersistenceOffer,
    responseToolInvocations,
  };
}