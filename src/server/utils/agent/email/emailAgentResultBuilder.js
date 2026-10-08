import {
  buildAgentOutputDebug,
  buildFamilyDebugPayload,
  captureTimingEntry,
  setCuratedToolMessages,
} from '@/server/utils/agent/agentDebug';
import { classifyAgentTurn } from '@/server/utils/agent/agentTurnClassifier';
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
  normalizedFollowUpSelection,
  openAIClient,
  normalizedMessage,
  debug,
}) {
  const turnClassification = await captureTimingEntry(
    debug?.timings?.phases?.responseShaping ?? null,
    async () => classifyAgentTurn({
      finalResponse,
      finalToolInvocations,
      normalizedFollowUpSelection,
      openAIClient,
      normalizedMessage,
      permissionToBroadenDetectionEnabled: false,
      debug,
    }),
  );
  const {
    answer,
    followUpOptions,
    priorToolInvocations,
    responseToolInvocations,
    turnType,
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
    turnType,
    answer,
    toolsUsed: Array.from(new Set(responseToolInvocations.map((invocation) => invocation.toolName))),
    citations: [],
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

export function buildEmailResponse({ familyResult, principal, debug }) {
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
    agent: buildEmailAgentDescriptor(),
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