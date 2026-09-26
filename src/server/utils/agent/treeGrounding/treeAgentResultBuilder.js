import {
  buildAgentOutputDebug,
  buildFamilyDebugPayload,
  captureTimingEntry,
  serializeDebugValue,
  setCuratedToolMessages,
} from '@/server/utils/agent/agentDebug';
import {
  classifyAgentTurn,
  FOLLOW_UP_OPTION_BROADER_ANSWER,
} from '@/server/utils/agent/agentTurnClassifier';
import {
  buildAgentFamilyResult,
} from '@/server/utils/agent/agentFamilyResult';
import { getAgentToolResultData } from '@/server/utils/agent/agentToolResult';
import { TREE_GROUNDING_FAMILY } from '@/server/utils/agent/treeGrounding/treeAgentCatalog';

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function buildCitationEntries(result, toolName) {
  const normalizedResult = getAgentToolResultData(result);

  return (normalizedResult?.results ?? []).map((entry) => ({
    toolName,
    treeId: entry.treeId,
    nodeId: entry.nodeId,
    title: entry.title,
    breadcrumb: entry.breadcrumb,
    nodeIdPath: entry.nodeIdPath,
    treeDisplayName: entry.treeDisplayName,
    matchSummary: entry.matchSummary ?? null,
    attachmentFileNames: entry.attachmentFileNames ?? [],
  }));
}

function dedupeCitations(citations) {
  const citationsByKey = new Map();

  citations.forEach((citation) => {
    const key = `${citation.treeId}::${citation.nodeId}::${citation.toolName}`;

    if (!citationsByKey.has(key)) {
      citationsByKey.set(key, citation);
    }
  });

  return Array.from(citationsByKey.values());
}

export async function buildTreeGroundingFamilyResult({
  finalResponse,
  finalToolInvocations,
  normalizedFollowUpSelection,
  openAIClient,
  normalizedMessage,
  debug,
  agent,
}) {
  const turnClassification = await captureTimingEntry(
    debug?.timings?.phases?.responseShaping ?? null,
    async () => classifyAgentTurn({
      finalResponse,
      finalToolInvocations,
      normalizedFollowUpSelection,
      openAIClient,
      normalizedMessage,
      debug,
    }),
  );
  const {
    answer,
    followUpOptions,
    permissionToBroadenDetection,
    priorToolInvocations,
    responseToolInvocations,
    groundedResponseReviewSteps,
    turnType,
  } = turnClassification;

  const citations = await captureTimingEntry(
    debug?.timings?.phases?.citationAssembly ?? null,
    async () => dedupeCitations(
      finalToolInvocations.flatMap((invocation) => buildCitationEntries(invocation.output, invocation.toolName)),
    ),
  );

  if (debug) {
    setCuratedToolMessages(debug);
    debug.family = {
      citations: serializeDebugValue(citations),
      permissionToBroadenDetection: serializeDebugValue(permissionToBroadenDetection),
      groundedResponseReview: serializeDebugValue(groundedResponseReviewSteps),
      turnType,
    };
    debug.agentOutput = buildAgentOutputDebug({
      agent,
      response: finalResponse,
      answer,
    });
  }

  const familyResult = buildAgentFamilyResult({
    sourceToolFamily: TREE_GROUNDING_FAMILY,
    turnType,
    answer,
    toolsUsed: Array.from(new Set(responseToolInvocations.map((invocation) => invocation.toolName))),
    citations,
    followUpOptions,
    familyPayload: {
      responseToolInvocations,
      priorToolInvocations,
    },
    ...(debug ? { debug: buildFamilyDebugPayload(debug) } : {}),
  });

  return {
    familyResult,
  };
}

export function buildTreeGroundingResponse({ familyResult, agent, principal, debug }) {
  const responseToolInvocations = Array.isArray(familyResult?.familyPayload?.responseToolInvocations)
    ? familyResult.familyPayload.responseToolInvocations
    : [];
  const priorToolInvocations = Array.isArray(familyResult?.familyPayload?.priorToolInvocations)
    ? familyResult.familyPayload.priorToolInvocations
    : [];

  return {
    schemaVersion: familyResult.schemaVersion,
    sourceToolFamily: familyResult.sourceToolFamily,
    answer: familyResult.answer,
    agent: {
      id: agent.id,
      name: agent.name,
      version: agent.version ?? null,
    },
    toolsUsed: familyResult.toolsUsed,
    toolInvocations: responseToolInvocations,
    priorToolInvocations,
    turnType: familyResult.turnType,
    followUpOptions: Array.isArray(familyResult.followUpOptions) ? familyResult.followUpOptions : [],
    citations: Array.isArray(familyResult.citations) ? familyResult.citations : [],
    familyPayload: familyResult.familyPayload ?? null,
    principal: principal
      ? {
        userId: principal.userId ?? null,
        userDetails: principal.userDetails ?? null,
      }
      : null,
    debug: debug ?? undefined,
  };
}