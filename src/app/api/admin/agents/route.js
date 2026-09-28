import { NextResponse } from 'next/server';
import { parseClientPrincipal } from '@/server/utils/auth';
import {
  getAgentFamilyRegistration,
  listAgentFamilyRegistrations,
} from '@/server/utils/agent/agentFamilyRegistry';
import { hasClientPrincipalRole } from '@/shared/clientPrincipal';

function assertAdminPrincipal(principal) {
  if (!hasClientPrincipalRole(principal, 'mdsadmins')) {
    throw new Error('Admin role mdsadmins is required');
  }
}

async function buildFamilyStatus(registration) {
  const supportsHostedPublishing = Boolean(registration?.supportsHostedPublishing);
  const baseStatus = {
    family: String(registration?.family ?? '').trim(),
    label: String(registration?.label ?? registration?.family ?? '').trim(),
    description: String(registration?.description ?? '').trim() || null,
    supportsHostedPublishing,
    hostedStatus: supportsHostedPublishing ? 'unknown' : 'unsupported',
    hostedAgentName: null,
    lastPublishedAt: null,
    toolCount: null,
    excludedTreeCount: null,
    statusError: null,
  };

  if (!supportsHostedPublishing || typeof registration?.getHostedPublishStatus !== 'function') {
    return baseStatus;
  }

  try {
    const status = await registration.getHostedPublishStatus();

    return {
      ...baseStatus,
      hostedStatus: String(status?.hostedStatus ?? 'unknown').trim() || 'unknown',
      hostedAgentName: String(status?.hostedAgentName ?? '').trim() || null,
      lastPublishedAt: status?.lastPublishedAt ?? null,
      toolCount: Number.isInteger(status?.toolCount) ? status.toolCount : null,
      excludedTreeCount: Number.isInteger(status?.excludedTreeCount) ? status.excludedTreeCount : null,
    };
  } catch (error) {
    return {
      ...baseStatus,
      hostedStatus: 'status_error',
      statusError: error instanceof Error ? error.message : 'Hosted agent status could not be loaded.',
    };
  }
}

async function buildAllFamilyStatuses() {
  const registrations = listAgentFamilyRegistrations();
  return Promise.all(registrations.map((registration) => buildFamilyStatus(registration)));
}

export async function GET(request) {
  try {
    const principal = parseClientPrincipal(request);
    assertAdminPrincipal(principal);

    return NextResponse.json({
      families: await buildAllFamilyStatuses(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Agent families could not be loaded.' },
      { status: 403 },
    );
  }
}

export async function POST(request) {
  try {
    const principal = parseClientPrincipal(request);
    assertAdminPrincipal(principal);
    const payload = await request.json();
    const family = String(payload?.family ?? '').trim();
    const action = String(payload?.action ?? 'publish').trim();
    const registration = getAgentFamilyRegistration(family);

    if (!family || !registration) {
      return NextResponse.json({ error: 'A valid family is required.' }, { status: 400 });
    }

    if (action !== 'publish') {
      return NextResponse.json({ error: `Unsupported action "${action}".` }, { status: 400 });
    }

    if (!registration.supportsHostedPublishing || typeof registration.publishHostedAgent !== 'function') {
      return NextResponse.json({ error: `Hosted publishing is not supported for family "${family}".` }, { status: 400 });
    }

    const publishStatus = await registration.publishHostedAgent();
    const refreshedStatus = await buildFamilyStatus(registration);

    return NextResponse.json({
      family: refreshedStatus,
      publish: {
        hostedStatus: String(publishStatus?.hostedStatus ?? refreshedStatus.hostedStatus ?? 'published'),
        hostedAgentName: String(publishStatus?.hostedAgentName ?? refreshedStatus.hostedAgentName ?? '').trim() || null,
        lastPublishedAt: publishStatus?.lastPublishedAt ?? refreshedStatus.lastPublishedAt ?? null,
        toolCount: Number.isInteger(publishStatus?.toolCount) ? publishStatus.toolCount : refreshedStatus.toolCount,
        excludedTreeCount: Number.isInteger(publishStatus?.excludedTreeCount) ? publishStatus.excludedTreeCount : refreshedStatus.excludedTreeCount,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Hosted agent could not be published.';
    const status = message === 'Admin role mdsadmins is required' ? 403 : 500;

    return NextResponse.json({ error: message }, { status });
  }
}