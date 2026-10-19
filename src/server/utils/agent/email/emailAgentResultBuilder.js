import {
  buildAgentOutputDebug,
  buildFamilyDebugPayload,
  captureTimingEntry,
  setCuratedToolMessages,
} from '@/server/utils/agent/agentDebug';
import { readAgentTurnState } from '@/server/utils/agent/agentTurnStateReader';
import { buildAgentFamilyResult } from '@/server/utils/agent/agentFamilyResult';
import { getRequiredFoundryFamilyConfig } from '@/server/utils/foundryAgentClient';
import { EMAIL_FAMILY } from '@/server/utils/agent/email/emailAgentCatalog';

function buildEmailAgentDescriptor() {
  const { modelDeploymentName } = getRequiredFoundryFamilyConfig(EMAIL_FAMILY);

  return {
    id: null,
    name: EMAIL_FAMILY,
    version: modelDeploymentName,
  };
}

export async function buildEmailFamilyResult({
  finalResponse,
  finalToolInvocations,
  debug,
}) {
  const turnClassification = await captureTimingEntry(
    debug?.timings?.phases?.responseShaping ?? null,
    async () => readAgentTurnState({
      finalResponse,
      finalToolInvocations,
      requireReportedAnswerState: false,
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

  if (debug) {
    setCuratedToolMessages(debug);
    debug.agentOutput = buildAgentOutputDebug({
      agent: buildEmailAgentDescriptor(),
      response: finalResponse,
      answer,
    });
  }

  const familyResult = buildAgentFamilyResult({
    sourceToolFamily: EMAIL_FAMILY,
    answer,
    toolsUsed: Array.from(new Set(responseToolInvocations.map((invocation) => invocation.toolName))),
    citations: [],
    familyPayload: {
      knowledgeMode,
      isPersistenceOffer,
      isPermissionToBroadenRequest,
      responseToolInvocations,
    },
    ...(debug ? { debug: buildFamilyDebugPayload(debug) } : {}),
  });

  return {
    familyResult,
  };
}

export function buildEmailResponse({ familyResult, principal, debug }) {
  const responseToolInvocations = Array.isArray(familyResult?.familyPayload?.responseToolInvocations)
    ? familyResult.familyPayload.responseToolInvocations
    : [];

  return {
    schemaVersion: familyResult.schemaVersion,
    sourceToolFamily: familyResult.sourceToolFamily,
    answer: familyResult.answer,
    agent: buildEmailAgentDescriptor(),
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