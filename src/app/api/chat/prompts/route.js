import { NextResponse } from 'next/server';
import { requireAuthenticatedPrincipal } from '@/server/utils/auth';
import { listRegisteredAgentFamilies } from '@/server/utils/agent/agentFamilyRegistry';
import { listSavedPrompts, savePrompt } from '@/server/utils/agent/savedPromptRepository';

export const runtime = 'nodejs';

function isValidFamily(family) {
  return typeof family === 'string' && listRegisteredAgentFamilies().includes(family);
}

function errorResponse(error) {
  console.error('Saved prompt request failed:', error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Saved prompt request failed.' },
    { status: error.status ?? 500 },
  );
}

export async function GET(request) {
  try {
    const principal = requireAuthenticatedPrincipal(request);
    const family = new URL(request.url).searchParams.get('family');
    if (!isValidFamily(family)) {
      return NextResponse.json({ error: 'A registered agent family is required.' }, { status: 400 });
    }
    const prompts = await listSavedPrompts({ principal, family });
    return NextResponse.json({ prompts }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request) {
  try {
    const principal = requireAuthenticatedPrincipal(request);
    let payload;
    try {
      payload = await request.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      return NextResponse.json({ error: 'A valid JSON body is required.' }, { status: 400 });
    }
    if (!isValidFamily(payload?.family) || typeof payload?.content !== 'string' || !payload.content.trim()) {
      return NextResponse.json({ error: 'A registered agent family and non-empty prompt are required.' }, { status: 400 });
    }
    const prompt = await savePrompt({ principal, family: payload.family, content: payload.content });
    return NextResponse.json({ prompt }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
