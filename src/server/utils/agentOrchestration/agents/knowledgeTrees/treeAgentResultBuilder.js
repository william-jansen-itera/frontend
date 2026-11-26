import {
  buildAgentOutputDebug,
  buildFamilyDebugPayload,
  captureTimingEntry,
  serializeDebugValue,
  setCuratedToolMessages,
} from '@/server/utils/agentOrchestration/agentDebug';
import {
  readAgentTurnState,
} from '@/server/utils/agentOrchestration/agentTurnStateReader';
import {
  buildAgentFamilyResult,
} from '@/server/utils/agentOrchestration/agentFamilyResult';
import { getAgentToolResultData } from '@/server/utils/agentOrchestration/agentToolResult';
import { KNOWLEDGE_TREES_FAMILY } from '@/server/utils/agentOrchestration/agents/knowledgeTrees/treeAgentCatalog';
import { getTreeList } from '@/server/utils/tree/treeCatalog';

function buildCitationEntries(result, toolName) {
  if (toolName === 'quiz') return [];
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

function summarizeQuizArguments(rawArguments) {
  let args = rawArguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return { argumentParseError: 'Quiz tool arguments contain invalid JSON.' };
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { argumentParseError: 'Quiz tool arguments must be a JSON object.' };
  }
  return Object.fromEntries(Object.entries(args).filter(([key]) =>
    ['operation', 'quizId', 'setupId', 'treeId', 'rootIds', 'questionId', 'version', 'questionCount', 'language', 'offset'].includes(key)));
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
      finalToolInvocations: finalToolInvocations.map((invocation) => invocation.toolName !== 'quiz' ? invocation : {
        ...invocation,
        arguments: summarizeQuizArguments(invocation.arguments),
      }),
      answerStateOptions: {
        allowBroadMode: true,
        allowPersistence: true,
        requirePersistenceOfferForBroad: true,
        requirePersistenceAction: true,
        requireWaitingForContinuation: true,
      },
      debug,
    }),
  );
  const {
    answer,
    responseLanguage,
    knowledgeMode,
    isPersistenceOffer,
    isPermissionToBroadenRequest,
    isWaitingForContinuation,
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
      isWaitingForContinuation,
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
      responseLanguage,
      knowledgeMode,
      isPersistenceOffer,
      isPermissionToBroadenRequest,
      isWaitingForContinuation,
      visibilityScope,
      responseToolInvocations: enrichedResponseToolInvocations,
    },
    ...(debug ? { debug: buildFamilyDebugPayload(debug) } : {}),
  });

  return {
    familyResult,
  };
}

export function buildKnowledgeTreesInteractionResponse({ interaction, language, principal, debug }) {
  const familyResult = buildAgentFamilyResult({
    sourceToolFamily: KNOWLEDGE_TREES_FAMILY,
    answer: interaction.prompt,
    toolsUsed: [],
    citations: [],
    familyPayload: {
      responseLanguage: language,
      knowledgeMode: 'grounded',
      isPersistenceOffer: false,
      isPermissionToBroadenRequest: false,
      isWaitingForContinuation: false,
      visibilityScope: null,
      responseToolInvocations: [],
      interaction,
    },
  });
  return {
    ...buildKnowledgeTreesResponse({ familyResult, agent: null, principal, debug }),
    interaction,
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
    responseLanguage: familyResult?.familyPayload?.responseLanguage ?? null,
    agent: agent ? {
      id: agent.id,
      name: agent.name,
      version: agent.version ?? null,
    } : null,
    toolsUsed: familyResult.toolsUsed,
    toolInvocations: responseToolInvocations,
    knowledgeMode: familyResult?.familyPayload?.knowledgeMode ?? null,
    isPersistenceOffer: familyResult?.familyPayload?.isPersistenceOffer ?? false,
    isPermissionToBroadenRequest: familyResult?.familyPayload?.isPermissionToBroadenRequest ?? false,
    isWaitingForContinuation: familyResult?.familyPayload?.isWaitingForContinuation ?? false,
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
