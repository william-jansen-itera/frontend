import { NextResponse } from 'next/server';
import { generateTreeDescriptionDraft, publishStoredTreeDescriptions } from '@/server/utils/chatService';
import { parseClientPrincipal } from '@/server/utils/auth';
import { hasClientPrincipalRole } from '@/shared/clientPrincipal';
import {
  createTree,
  deleteTree,
  getTreeList,
  purgeTree,
  updateTreeDescription,
  updateTreeTitle,
  updateTreeVisibility,
} from '@/server/utils/treeCatalog';

function parseTreeId(value) {
  const parsedValue = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsedValue)) {
    return null;
  }

  return parsedValue;
}

function getVisibilityFilter(request) {
  const { searchParams } = new URL(request.url);
  return searchParams.get('visibility') ?? 'public';
}

function getPayloadVisibility(payload) {
  return String(payload?.visibility ?? '').trim() || 'public';
}

function isAdminPrincipal(principal) {
  return hasClientPrincipalRole(principal, 'mdsadmin');
}

export async function GET(request) {
  try {
    const principal = parseClientPrincipal(request);
    const { searchParams } = new URL(request.url);
    const includeDeleted = String(searchParams.get('includeDeleted') ?? '').trim().toLowerCase() === 'true';
    const deletedOnly = String(searchParams.get('deletedOnly') ?? '').trim().toLowerCase() === 'true';

    if ((includeDeleted || deletedOnly) && !isAdminPrincipal(principal)) {
      return NextResponse.json({ error: 'Admin role mdsadmin is required' }, { status: 403 });
    }

    return NextResponse.json(await getTreeList({
      principal,
      visibility: getVisibilityFilter(request),
      enforceAccess: deletedOnly ? false : true,
      includeDeleted,
      deletedOnly,
    }));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const principal = parseClientPrincipal(request);
    const action = String(payload?.action ?? '').trim();

    if (action === 'generate-description') {
      const parsedTreeId = parseTreeId(payload?.treeId);

      if (!parsedTreeId) {
        return NextResponse.json({ error: 'Invalid request, treeId is required' }, { status: 400 });
      }

      const result = await generateTreeDescriptionDraft(parsedTreeId, {
        principal,
        enforceAccess: true,
      });

      return NextResponse.json({
        treeId: String(parsedTreeId),
        generatedDescription: result.generatedDescription,
      });
    }

    if (action === 'save-description') {
      const parsedTreeId = parseTreeId(payload?.treeId);
      const description = String(payload?.description ?? '');

      if (!parsedTreeId || !description.trim()) {
        return NextResponse.json(
          { error: 'Invalid request, treeId and description are required' },
          { status: 400 },
        );
      }

      const updatedTree = await updateTreeDescription({
        treeId: parsedTreeId,
        description,
        principal,
        enforceAccess: true,
      });

      try {
        const syncResult = await publishStoredTreeDescriptions();
        const trees = await getTreeList({ principal, visibility: getPayloadVisibility(payload), enforceAccess: true });
        const syncedTree = trees.find((tree) => String(tree.id) === String(parsedTreeId)) ?? updatedTree;

        return NextResponse.json({
          updatedTree: syncedTree,
          trees,
          saveStatus: {
            status: 'success',
            message: 'Description was saved.',
          },
          syncStatus: {
            status: 'success',
            message: 'Stored descriptions were published to the agent.',
            mode: syncResult.syncMode,
            excludedTreeCount: Array.isArray(syncResult.excludedTrees) ? syncResult.excludedTrees.length : 0,
            excludedTrees: Array.isArray(syncResult.excludedTrees) ? syncResult.excludedTrees : [],
            agent: {
              id: syncResult.agent.id,
              name: syncResult.agent.name,
              version: syncResult.agent.version ?? null,
            },
          },
        });
      } catch (error) {
        const trees = await getTreeList({ principal, visibility: getPayloadVisibility(payload), enforceAccess: true });

        return NextResponse.json({
          updatedTree,
          trees,
          saveStatus: {
            status: 'success',
            message: 'Description was saved.',
          },
          syncStatus: {
            status: 'failed',
            message: error instanceof Error ? error.message : 'Stored-description sync failed.',
            code: error?.code ?? null,
            missingTrees: Array.isArray(error?.missingTrees) ? error.missingTrees : [],
          },
        }, { status: 207 });
      }
    }

    const { name } = payload;

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Invalid request, name is required' }, { status: 400 });
    }

    const createdTree = await createTree({ name, principal });

    return NextResponse.json({
      createdTree,
      trees: await getTreeList({ principal, visibility: getPayloadVisibility(payload), enforceAccess: true }),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const principal = parseClientPrincipal(request);
    const { treeId, name, isPrivate, visibility } = await request.json();
    const parsedTreeId = parseTreeId(treeId);
    const normalizedVisibility = String(visibility ?? '').trim() || 'public';
    const hasName = typeof name === 'string';
    const nextName = hasName ? name.trim() : '';
    const hasVisibility = typeof isPrivate === 'boolean';

    if (!parsedTreeId) {
      return NextResponse.json({ error: 'Invalid request, treeId is required' }, { status: 400 });
    }

    if (!hasName && !hasVisibility) {
      return NextResponse.json({ error: 'Invalid request, at least one of name or isPrivate must be provided' }, { status: 400 });
    }

    if (hasName && !nextName) {
      return NextResponse.json({ error: 'Invalid request, name must not be empty' }, { status: 400 });
    }

    let updatedTree = null;

    if (hasName) {
      updatedTree = await updateTreeTitle({ treeId: parsedTreeId, name: nextName, principal, enforceAccess: true });
    }

    if (hasVisibility) {
      updatedTree = await updateTreeVisibility({ treeId: parsedTreeId, isPrivate, principal, enforceAccess: true });
    }

    return NextResponse.json({
      updatedTree,
      trees: await getTreeList({ principal, visibility: normalizedVisibility, enforceAccess: true }),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const principal = parseClientPrincipal(request);
    const parsedTreeId = parseTreeId(searchParams.get('treeId'));
    const visibility = searchParams.get('visibility') ?? 'public';
    const shouldPurge = String(searchParams.get('purge') ?? '').trim().toLowerCase() === 'true';

    if (!parsedTreeId) {
      return NextResponse.json({ error: 'Invalid request, treeId is required' }, { status: 400 });
    }

    if (shouldPurge) {
      if (!isAdminPrincipal(principal)) {
        return NextResponse.json({ error: 'Admin role mdsadmin is required' }, { status: 403 });
      }

      await purgeTree({ treeId: parsedTreeId, principal, enforceAccess: false });

      return NextResponse.json({
        success: true,
        purged: true,
        trees: await getTreeList({ principal, visibility, enforceAccess: true }),
      });
    }

    await deleteTree({ treeId: parsedTreeId, principal, enforceAccess: true });

    try {
      const syncResult = await publishStoredTreeDescriptions();

      return NextResponse.json({
        success: true,
        trees: await getTreeList({ principal, visibility, enforceAccess: true }),
        syncStatus: {
          status: 'success',
          message: 'Stored descriptions were published to the agent.',
          mode: syncResult.syncMode,
          excludedTreeCount: Array.isArray(syncResult.excludedTrees) ? syncResult.excludedTrees.length : 0,
          excludedTrees: Array.isArray(syncResult.excludedTrees) ? syncResult.excludedTrees : [],
          agent: {
            id: syncResult.agent.id,
            name: syncResult.agent.name,
            version: syncResult.agent.version ?? null,
          },
        },
      });
    } catch (error) {
      return NextResponse.json({
        success: true,
        trees: await getTreeList({ principal, visibility, enforceAccess: true }),
        syncStatus: {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Stored-description sync failed after tree deletion.',
          code: error?.code ?? null,
          missingTrees: Array.isArray(error?.missingTrees) ? error.missingTrees : [],
        },
      });
    }
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}