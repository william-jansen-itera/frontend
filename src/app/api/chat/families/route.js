import { NextResponse } from 'next/server';
import { listAvailableAgentFamilyStatuses } from '@/server/utils/agent/agentFamilyAvailability';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const families = await listAvailableAgentFamilyStatuses({ includeTools: false });

    return NextResponse.json({
      defaultFamily: families[0]?.family ?? null,
      families: families.map((family) => ({
        family: family.family,
        label: family.label,
        description: family.description,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Chat families could not be loaded.' },
      { status: 500 },
    );
  }
}