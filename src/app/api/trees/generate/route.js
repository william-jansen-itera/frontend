import { NextResponse } from 'next/server';
import { QueueClient } from '@azure/storage-queue';
import { parseClientPrincipal } from '@/server/utils/auth';
import { assertTreeAccess, getTreeForPopulation } from '@/server/utils/tree/treeCatalog';
import { createOrGetPopulateJob, failQueuedPopulateJob } from '@/server/utils/tree/treePopulateJobRepository';

const QUEUE_NAME = 'tree-populate-jobs';

function getQueueClient() {
  const connection = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connection) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
  return new QueueClient(connection, QUEUE_NAME);
}

function parseTreeId(value) {
  const parsedValue = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsedValue)) {
    return null;
  }

  return parsedValue;
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const parsedTreeId = parseTreeId(payload?.treeId);
    const principal = parseClientPrincipal(request);
    const visibility = String(payload?.visibility ?? '').trim() || 'public';

    if (!parsedTreeId) {
      return NextResponse.json({ error: 'Invalid request, treeId is required' }, { status: 400 });
    }

    await assertTreeAccess(parsedTreeId, {
      principal,
      visibility,
      requireWriteAccess: true,
    });

    const tree = await getTreeForPopulation(parsedTreeId, {
      principal,
      visibility,
      enforceAccess: true,
      requireWriteAccess: true,
    });

    if (!tree.description.trim()) {
      return NextResponse.json({ error: 'A saved description is required before populating a tree' }, { status: 400 });
    }

    const job = await createOrGetPopulateJob({ tree, principal });
    if (job.jobType !== 'populate') {
      return NextResponse.json({ error: 'Another tree job is already running.' }, { status: 409 });
    }
    if (job.isNew) {
      try {
        const queue = getQueueClient();
        await queue.createIfNotExists();
        await queue.sendMessage(Buffer.from(JSON.stringify({ jobId: job.jobId })).toString('base64'));
      } catch (error) {
        await failQueuedPopulateJob(job.jobId);
        console.error('Populate queue submission failed', error);
        throw new Error('Could not queue tree population.');
      }
    }

    return NextResponse.json({ jobId: job.jobId, treeId: String(parsedTreeId), jobType: job.jobType, status: job.status }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Tree population failed.' },
      { status: error?.status ?? 500 },
    );
  }
}
export { GET } from '../jobs/route';