import { NextResponse } from 'next/server';
import { parseClientPrincipal } from '@/server/utils/auth';
import { assertTreeAccess } from '@/server/utils/tree/treeCatalog';
import { getTreeJob } from '@/server/utils/tree/treePopulateJobRepository';

export async function GET(request) {
  try {
    const treeId = Number.parseInt(String(request.nextUrl.searchParams.get('treeId') ?? ''), 10);
    const visibility = request.nextUrl.searchParams.get('visibility') || 'public';
    const jobId = request.nextUrl.searchParams.get('jobId');
    if (!Number.isFinite(treeId) || treeId <= 0) return NextResponse.json({ error: 'treeId is required' }, { status: 400 });
    if (jobId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
      return NextResponse.json({ error: 'Invalid jobId' }, { status: 400 });
    }

    await assertTreeAccess(treeId, {
      principal: parseClientPrincipal(request), visibility, requireWriteAccess: true,
    });
    const job = await getTreeJob({ jobId, treeId });
    if (!job) return NextResponse.json({ error: 'Tree job was not found' }, { status: 404 });
    return NextResponse.json(job);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load tree job' }, { status: error?.status ?? 500 });
  }
}