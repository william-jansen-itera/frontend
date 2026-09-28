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
  const supportsPromptAgentPublishing = Boolean(registration?.supportsPromptAgentPublishing);
  const definedTools = typeof registration?.listDefinedTools === 'function'
    ? await registration.listDefinedTools()
    : [];
  const baseStatus = {
    family: String(registration?.family ?? '').trim(),
    label: String(registration?.label ?? registration?.family ?? '').trim(),
    description: String(registration?.description ?? '').trim() || null,
    tools: Array.isArray(definedTools) ? definedTools : [],
    supportsPromptAgentPublishing,
    promptAgentStatus: supportsPromptAgentPublishing ? 'unknown' : 'unsupported',
    promptAgentName: null,
    lastPublishedAt: null,
    toolCount: Array.isArray(definedTools) ? definedTools.filter((tool) => tool?.includedInPromptAgent !== false).length : 0,
    excludedTreeCount: null,
    statusError: null,
  };

  if (!supportsPromptAgentPublishing || typeof registration?.getPromptAgentPublishStatus !== 'function') {
    return baseStatus;
  }

  try {
    const status = await registration.getPromptAgentPublishStatus();

    return {
      ...baseStatus,
      promptAgentStatus: String(status?.promptAgentStatus ?? 'unknown').trim() || 'unknown',
      promptAgentName: String(status?.promptAgentName ?? '').trim() || null,
      lastPublishedAt: status?.lastPublishedAt ?? null,
      toolCount: Number.isInteger(status?.toolCount) ? status.toolCount : null,
      excludedTreeCount: Number.isInteger(status?.excludedTreeCount) ? status.excludedTreeCount : null,
    };
  } catch (error) {
    return {
      ...baseStatus,
      promptAgentStatus: 'status_error',
      statusError: error instanceof Error ? error.message : 'Prompt agent status could not be loaded.',
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

    if (!registration.supportsPromptAgentPublishing || typeof registration.publishPromptAgent !== 'function') {
      return NextResponse.json({ error: `Prompt agent publishing is not supported for family "${family}".` }, { status: 400 });
    }

    const publishStatus = await registration.publishPromptAgent();
    const refreshedStatus = await buildFamilyStatus(registration);

    return NextResponse.json({
      family: refreshedStatus,
      publish: {
        promptAgentStatus: String(publishStatus?.promptAgentStatus ?? refreshedStatus.promptAgentStatus ?? 'published'),
        promptAgentName: String(publishStatus?.promptAgentName ?? refreshedStatus.promptAgentName ?? '').trim() || null,
        lastPublishedAt: publishStatus?.lastPublishedAt ?? refreshedStatus.lastPublishedAt ?? null,
        toolCount: Number.isInteger(publishStatus?.toolCount) ? publishStatus.toolCount : refreshedStatus.toolCount,
        excludedTreeCount: Number.isInteger(publishStatus?.excludedTreeCount) ? publishStatus.excludedTreeCount : refreshedStatus.excludedTreeCount,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Prompt agent could not be published.';
    const status = message === 'Admin role mdsadmins is required' ? 403 : 500;

    return NextResponse.json({ error: message }, { status });
  }
}