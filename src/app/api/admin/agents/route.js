import { NextResponse } from 'next/server';
import { getRelevantPrincipalDetails, requireAuthenticatedPrincipal } from '@/server/utils/auth';
import {
  getAgentFamilyRegistration,
} from '@/server/utils/agent/agentFamilyRegistry';
import {
  buildAgentFamilyStatus,
  getAgentFamilyStatus,
  listAgentFamilyStatuses,
} from '@/server/utils/agent/agentFamilyAvailability';
import { setAgentFamilyActiveState } from '@/server/utils/agent/agentFamilyStateRepository';

function getErrorStatus(error, defaultStatus = 500) {
  const status = Number(error?.status);

  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return status;
  }

  return defaultStatus;
}

async function buildFamilyStatus(registration) {
  return buildAgentFamilyStatus(registration, { includeTools: true });
}

async function buildAllFamilyStatuses() {
  return listAgentFamilyStatuses({ includeTools: true });
}

function buildUpdatedByFromPrincipal(principal) {
  const principalDetails = getRelevantPrincipalDetails(principal);

  return {
    updatedByObjectId: String(principalDetails?.objectId ?? principalDetails?.userId ?? '').trim() || null,
    updatedByUserDetails: String(
      principalDetails?.userDetails
      ?? principalDetails?.preferredUsername
      ?? principalDetails?.displayName
      ?? '',
    ).trim() || null,
  };
}

export async function GET(request) {
  try {
    return NextResponse.json({
      families: await buildAllFamilyStatuses(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Agent families could not be loaded.' },
      { status: getErrorStatus(error) },
    );
  }
}

export async function POST(request) {
  try {
    const principal = requireAuthenticatedPrincipal(request);
    const payload = await request.json();
    const family = String(payload?.family ?? '').trim();
    const action = String(payload?.action ?? 'publish').trim();
    const registration = getAgentFamilyRegistration(family);

    if (!family || !registration) {
      return NextResponse.json({ error: 'A valid family is required.' }, { status: 400 });
    }

    if (action !== 'publish') {
      if (!['activate', 'deactivate', 'unpublish'].includes(action)) {
        return NextResponse.json({ error: `Unsupported action "${action}".` }, { status: 400 });
      }
    }

    const updatedBy = buildUpdatedByFromPrincipal(principal);

    if (action === 'publish') {
      if (!registration.supportsPromptAgentPublishing || typeof registration.publishPromptAgent !== 'function') {
        return NextResponse.json({ error: `Prompt agent publishing is not supported for family "${family}".` }, { status: 400 });
      }

      const publishStatus = await registration.publishPromptAgent();
      const refreshedStatus = await buildFamilyStatus(registration);

      return NextResponse.json({
        family: refreshedStatus,
        operation: {
          action,
          family,
          promptAgentStatus: String(publishStatus?.promptAgentStatus ?? refreshedStatus.promptAgentStatus ?? 'published'),
          promptAgentName: String(publishStatus?.promptAgentName ?? refreshedStatus.promptAgentName ?? '').trim() || null,
          lastPublishedAt: publishStatus?.lastPublishedAt ?? refreshedStatus.lastPublishedAt ?? null,
          isActive: refreshedStatus.isActive,
        },
      });
    }

    if (action === 'activate') {
      const currentStatus = await getAgentFamilyStatus(family, { includeTools: false });

      if (!currentStatus) {
        return NextResponse.json({ error: `A valid family is required.` }, { status: 400 });
      }

      if (currentStatus.requiresPublishedPromptAgent && currentStatus.promptAgentStatus !== 'published') {
        return NextResponse.json({ error: `Family "${family}" must be published before it can be activated.` }, { status: 400 });
      }

      const activationState = await setAgentFamilyActiveState(family, {
        isActive: true,
        reason: null,
        updatedBy,
      });
      const refreshedStatus = await buildFamilyStatus(registration);

      return NextResponse.json({
        family: refreshedStatus,
        operation: {
          action,
          family,
          isActive: activationState.isActive,
        },
      });
    }

    if (action === 'deactivate') {
      const activationState = await setAgentFamilyActiveState(family, {
        isActive: false,
        reason: 'Deactivated from admin agent-family controls.',
        updatedBy,
      });
      const refreshedStatus = await buildFamilyStatus(registration);

      return NextResponse.json({
        family: refreshedStatus,
        operation: {
          action,
          family,
          isActive: activationState.isActive,
        },
      });
    }

    if (!registration.supportsPromptAgentPublishing || typeof registration.unpublishPromptAgent !== 'function') {
      return NextResponse.json({ error: `Prompt agent unpublishing is not supported for family "${family}".` }, { status: 400 });
    }

    await setAgentFamilyActiveState(family, {
      isActive: false,
      reason: 'Prompt agent unpublished from admin agent-family controls.',
      updatedBy,
    });
    const unpublishStatus = await registration.unpublishPromptAgent();
    const refreshedStatus = await buildFamilyStatus(registration);

    return NextResponse.json({
      family: refreshedStatus,
      operation: {
        action,
        family,
        promptAgentStatus: String(unpublishStatus?.promptAgentStatus ?? refreshedStatus.promptAgentStatus ?? 'not_published'),
        promptAgentName: String(unpublishStatus?.promptAgentName ?? refreshedStatus.promptAgentName ?? '').trim() || null,
        lastPublishedAt: unpublishStatus?.lastPublishedAt ?? refreshedStatus.lastPublishedAt ?? null,
        isActive: refreshedStatus.isActive,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Agent family action could not be completed.';

    return NextResponse.json({ error: message }, { status: getErrorStatus(error) });
  }
}