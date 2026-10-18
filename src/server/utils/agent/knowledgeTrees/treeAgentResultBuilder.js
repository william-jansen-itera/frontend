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
import { KNOWLEDGE_TREES_FAMILY } from '@/server/utils/agent/knowledgeTrees/treeAgentCatalog';
import { getTreeList } from '@/server/utils/tree/treeCatalog';

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
    visibility: entry.visibility ?? null,
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

function parseToolTreeId(toolName) {
  const match = String(toolName ?? '').trim().match(/_(\d+)$/);
  return match ? match[1] : '';
}

async function enrichToolInvocationsWithTreeAccess(toolInvocations, principal) {
  if (!Array.isArray(toolInvocations) || toolInvocations.length === 0) {
    return [];
  }

  const treeIds = Array.from(new Set(
    toolInvocations
      .map((invocation) => parseToolTreeId(invocation?.toolName))
      .filter(Boolean),
  ));

  if (treeIds.length === 0) {
    return toolInvocations.map((invocation) => ({
      ...invocation,
      treeId: null,
      canAddToTree: false,
    }));
  }

  const writableTreeIds = new Set(
    (await getTreeList({
      principal,
      visibility: 'both',
      enforceAccess: true,
    }))
      .filter((tree) => Boolean(tree?.currentUserCanWrite))
      .map((tree) => String(tree.id)),
  );

  return toolInvocations.map((invocation) => {
    const treeId = parseToolTreeId(invocation?.toolName);

    return {
      ...invocation,
      treeId: treeId || null,
      canAddToTree: Boolean(treeId) && writableTreeIds.has(treeId),
    };
  });
}

export async function buildKnowledgeTreesFamilyResult({
  finalResponse,
  finalToolInvocations,
  normalizedFollowUpSelection,
  openAIClient,
  normalizedMessage,
  principal = null,
  visibilityScope = null,
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
      permissionToBroadenDetectionEnabled: true,
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
  const enrichedResponseToolInvocations = await enrichToolInvocationsWithTreeAccess(responseToolInvocations, principal);
  const enrichedPriorToolInvocations = await enrichToolInvocationsWithTreeAccess(priorToolInvocations, principal);

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
      visibilityScope: serializeDebugValue(visibilityScope),
      turnType,
    };
    debug.agentOutput = buildAgentOutputDebug({
      agent,
      response: finalResponse,
      answer,
    });
  }

  const familyResult = buildAgentFamilyResult({
    sourceToolFamily: KNOWLEDGE_TREES_FAMILY,
    turnType,
    answer,
    toolsUsed: Array.from(new Set(enrichedResponseToolInvocations.map((invocation) => invocation.toolName))),
    citations,
    followUpOptions,
    familyPayload: {
      visibilityScope,
      responseToolInvocations: enrichedResponseToolInvocations,
      priorToolInvocations: enrichedPriorToolInvocations,
    },
    ...(debug ? { debug: buildFamilyDebugPayload(debug) } : {}),
  });

  return {
    familyResult,
  };
}

export function buildKnowledgeTreesResponse({ familyResult, agent, principal, debug }) {
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
