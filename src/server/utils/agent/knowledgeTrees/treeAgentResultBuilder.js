import {
  buildAgentOutputDebug,
  buildFamilyDebugPayload,
  captureTimingEntry,
  serializeDebugValue,
  setCuratedToolMessages,
} from '@/server/utils/agent/agentDebug';
import {
  readAgentTurnState,
} from '@/server/utils/agent/agentTurnStateReader';
import {
  buildAgentFamilyResult,
} from '@/server/utils/agent/agentFamilyResult';
import { getAgentToolResultData } from '@/server/utils/agent/agentToolResult';
import { KNOWLEDGE_TREES_FAMILY } from '@/server/utils/agent/knowledgeTrees/treeAgentCatalog';
import { getTreeList } from '@/server/utils/tree/treeCatalog';

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
  principal = null,
  visibilityScope = null,
  debug,
  agent,
}) {
  const turnClassification = await captureTimingEntry(
    debug?.timings?.phases?.responseShaping ?? null,
    async () => readAgentTurnState({
      finalResponse,
      finalToolInvocations,
      answerStateOptions: {
        allowBroadMode: true,
        allowPersistence: true,
        requirePersistenceOfferForBroad: true,
      },
      debug,
    }),
  );
  const {
    answer,
    knowledgeMode,
    isPersistenceOffer,
    isPermissionToBroadenRequest,
    responseToolInvocations,
  } = turnClassification;
  const enrichedResponseToolInvocations = await enrichToolInvocationsWithTreeAccess(responseToolInvocations, principal);

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
      knowledgeMode,
      isPersistenceOffer,
      isPermissionToBroadenRequest,
      visibilityScope: serializeDebugValue(visibilityScope),
    };
    debug.agentOutput = buildAgentOutputDebug({
      agent,
      response: finalResponse,
      answer,
    });
  }

  const familyResult = buildAgentFamilyResult({
    sourceToolFamily: KNOWLEDGE_TREES_FAMILY,
    answer,
    toolsUsed: Array.from(new Set(enrichedResponseToolInvocations.map((invocation) => invocation.toolName))),
    citations,
    familyPayload: {
      knowledgeMode,
      isPersistenceOffer,
      isPermissionToBroadenRequest,
      visibilityScope,
      responseToolInvocations: enrichedResponseToolInvocations,
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
    knowledgeMode: familyResult?.familyPayload?.knowledgeMode ?? null,
    isPersistenceOffer: familyResult?.familyPayload?.isPersistenceOffer ?? false,
    isPermissionToBroadenRequest: familyResult?.familyPayload?.isPermissionToBroadenRequest ?? false,
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
