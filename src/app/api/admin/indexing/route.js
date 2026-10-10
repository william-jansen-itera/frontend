import { NextResponse } from 'next/server';
import {
  requestSearchIndexerReset,
  requestSearchIndexerRun,
} from '@/server/utils/azureSearch';

const SQL_INDEXER_NAME = process.env.AZURE_SEARCH_SQL_INDEXER_NAME || 'tree-sql-indexer';
const BLOB_INDEXER_NAME = process.env.AZURE_SEARCH_BLOB_INDEXER_NAME || 'tree-blob-indexer';

function normalizeTarget(target) {
  const normalizedTarget = String(target ?? '').trim().toLowerCase();

  if (normalizedTarget === 'node-data' || normalizedTarget === 'blob-content' || normalizedTarget === 'all') {
    return normalizedTarget;
  }

  return null;
}

function normalizeMode(mode) {
  const normalizedMode = String(mode ?? '').trim().toLowerCase();

  if (normalizedMode === 'incremental' || normalizedMode === 'full') {
    return normalizedMode;
  }

  return null;
}

function getIndexerTargets(target) {
  if (target === 'node-data') {
    return [{ key: 'node-data', indexerName: SQL_INDEXER_NAME }];
  }

  if (target === 'blob-content') {
    return [{ key: 'blob-content', indexerName: BLOB_INDEXER_NAME }];
  }

  return [
    { key: 'node-data', indexerName: SQL_INDEXER_NAME },
    { key: 'blob-content', indexerName: BLOB_INDEXER_NAME },
  ];
}

async function performOperationSequence(target, mode) {
  const indexerTargets = getIndexerTargets(target);
  const completedOperations = [];
  const failedOperations = [];
  const operationSteps = mode === 'full' ? ['reset', 'run'] : ['run'];

  for (const operationName of operationSteps) {
    for (const indexerTarget of indexerTargets) {
      try {
        const result = operationName === 'reset'
          ? await requestSearchIndexerReset(indexerTarget.indexerName)
          : await requestSearchIndexerRun(indexerTarget.indexerName);

        completedOperations.push({
          target: indexerTarget.key,
          mode,
          operation: operationName,
          indexerName: indexerTarget.indexerName,
          status: result.status,
          reason: result.reason ?? null,
          message: result.message ?? null,
        });
      } catch (error) {
        failedOperations.push({
          target: indexerTarget.key,
          mode,
          operation: operationName,
          indexerName: indexerTarget.indexerName,
          error: error instanceof Error ? error.message : 'The indexer operation failed.',
        });

        return {
          success: false,
          target,
          mode,
          operations: completedOperations,
          failedOperations,
        };
      }
    }
  }

  return {
    success: true,
    target,
    mode,
    operations: completedOperations,
    failedOperations,
  };
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const target = normalizeTarget(payload?.target);
    const mode = normalizeMode(payload?.mode);

    if (!target || !mode) {
      return NextResponse.json(
        { error: 'Invalid request, supported target and mode values are required.' },
        { status: 400 },
      );
    }

    const result = await performOperationSequence(target, mode);
    const status = result.success ? 200 : 500;

    return NextResponse.json(result, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The request failed';

    return NextResponse.json({ error: message }, { status: 500 });
  }
}