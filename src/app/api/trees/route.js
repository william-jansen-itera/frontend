import { NextResponse } from 'next/server';
import { generateTreeDescriptionDraft, publishStoredTreeDescriptions } from '@/server/utils/chatService';
import { parseClientPrincipal } from '@/server/utils/auth';
import { getPurgeProxyErrorStatus, invokePurgeFunction } from '@/server/utils/purgeFunctionClient';
import { getEntraUserByObjectId, searchEntraUsers } from '@/server/utils/swaRoleMapping';
import { hasClientPrincipalRole } from '@/shared/clientPrincipal';
import {
  addTreeEditor,
  createTree,
  deleteTree,
  getTreeList,
  removeTreeEditor,
  transitionTreeReviewStatus,
  TREE_REVIEW_ACTION_VALUES,
  updateTreeDescription,
  updateTreeApprovalEnabled,
  updateTreeOwner,
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
  return hasClientPrincipalRole(principal, 'mdsadmins');
}

function isAuthenticatedPrincipal(principal) {
  return Boolean(String(principal?.objectId ?? principal?.userId ?? '').trim());
}

function getErrorStatus(error, defaultStatus = 500) {
  const status = Number(error?.status);

  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return status;
  }

  return defaultStatus;
}

export async function GET(request) {
  try {
    const principal = parseClientPrincipal(request);
    const { searchParams } = new URL(request.url);
    const includeDeleted = String(searchParams.get('includeDeleted') ?? '').trim().toLowerCase() === 'true';
    const deletedOnly = String(searchParams.get('deletedOnly') ?? '').trim().toLowerCase() === 'true';

    if ((includeDeleted || deletedOnly) && !isAdminPrincipal(principal)) {
      return NextResponse.json({ error: 'Admin role mdsadmins is required' }, { status: 403 });
    }

    return NextResponse.json(await getTreeList({
      principal,
      visibility: getVisibilityFilter(request),
      enforceAccess: deletedOnly ? false : true,
      includeDeleted,
      deletedOnly,
    }));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: getErrorStatus(err) });
  }
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const principal = parseClientPrincipal(request);
    const action = String(payload?.action ?? '').trim();

    if (action === 'search-transfer-targets') {
      const query = String(payload?.query ?? '').trim();

      if (!isAuthenticatedPrincipal(principal)) {
        return NextResponse.json({ error: 'Authentication is required' }, { status: 401 });
      }

      if (query.length < 2) {
        return NextResponse.json({ error: 'Invalid request, query must contain at least 2 characters' }, { status: 400 });
      }

      return NextResponse.json({
        matches: await searchEntraUsers(query, {}),
      });
    }

    if (action === 'search-editor-targets') {
      const query = String(payload?.query ?? '').trim();

      if (!isAuthenticatedPrincipal(principal)) {
        return NextResponse.json({ error: 'Authentication is required' }, { status: 401 });
      }

      if (query.length < 2) {
        return NextResponse.json({ error: 'Invalid request, query must contain at least 2 characters' }, { status: 400 });
      }

      return NextResponse.json({
        matches: await searchEntraUsers(query, {}),
      });
    }

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

    if (action === 'unpublish-description') {
      const parsedTreeId = parseTreeId(payload?.treeId);

      if (!parsedTreeId) {
        return NextResponse.json(
          { error: 'Invalid request, treeId is required' },
          { status: 400 },
        );
      }

      const updatedTree = await updateTreeDescription({
        treeId: parsedTreeId,
        description: '',
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
            message: 'Description was cleared.',
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
            message: 'Description was cleared.',
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
    const {
      action,
      treeId,
      name,
      isPrivate,
      visibility,
      targetOwnerObjectId,
      approvalEnabled,
      rejectionComment,
    } = await request.json();
    const parsedTreeId = parseTreeId(treeId);
    const normalizedVisibility = String(visibility ?? '').trim() || 'public';
    const normalizedAction = String(action ?? '').trim().toLowerCase();
    const hasName = typeof name === 'string';
    const nextName = hasName ? name.trim() : '';
    const hasVisibility = typeof isPrivate === 'boolean';

    if (!parsedTreeId) {
      return NextResponse.json({ error: 'Invalid request, treeId is required' }, { status: 400 });
    }

    if (normalizedAction === 'transfer-owner') {
      const targetOwner = await getEntraUserByObjectId(targetOwnerObjectId, {});

      if (!targetOwner?.objectId) {
        return NextResponse.json({ error: 'Target user was not found in Entra ID' }, { status: 404 });
      }

      const updatedTree = await updateTreeOwner({
        treeId: parsedTreeId,
        ownerObjectId: targetOwner.objectId,
        ownerUserDetails: targetOwner.userDetails,
        ownerDisplayName: targetOwner.displayName,
        principal,
        enforceAccess: true,
      });

      return NextResponse.json({
        updatedTree,
        trees: await getTreeList({ principal, visibility: normalizedVisibility, enforceAccess: true }),
      });
    }

    if (normalizedAction === 'add-editor') {
      const targetEditor = await getEntraUserByObjectId(targetOwnerObjectId, {});

      if (!targetEditor?.objectId) {
        return NextResponse.json({ error: 'Target user was not found in Entra ID' }, { status: 404 });
      }

      const updatedTree = await addTreeEditor({
        treeId: parsedTreeId,
        editorObjectId: targetEditor.objectId,
        editorUserDetails: targetEditor.userDetails,
        editorDisplayName: targetEditor.displayName,
        principal,
        enforceAccess: true,
      });

      return NextResponse.json({
        updatedTree,
        trees: await getTreeList({ principal, visibility: normalizedVisibility, enforceAccess: true }),
      });
    }

    if (normalizedAction === 'remove-editor') {
      const editorObjectId = String(targetOwnerObjectId ?? '').trim();

      if (!editorObjectId) {
        return NextResponse.json({ error: 'Invalid request, target editor object ID is required' }, { status: 400 });
      }

      const updatedTree = await removeTreeEditor({
        treeId: parsedTreeId,
        editorObjectId,
        principal,
        enforceAccess: true,
      });

      return NextResponse.json({
        updatedTree,
        trees: await getTreeList({ principal, visibility: normalizedVisibility, enforceAccess: true }),
      });
    }

    if (normalizedAction === 'set-approval-enabled') {
      if (typeof approvalEnabled !== 'boolean') {
        return NextResponse.json({ error: 'Invalid request, approvalEnabled must be provided' }, { status: 400 });
      }

      const updatedTree = await updateTreeApprovalEnabled({
        treeId: parsedTreeId,
        approvalEnabled,
        principal,
        enforceAccess: true,
      });

      return NextResponse.json({
        updatedTree,
        trees: await getTreeList({ principal, visibility: normalizedVisibility, enforceAccess: true }),
      });
    }

    if (TREE_REVIEW_ACTION_VALUES.includes(normalizedAction)) {
      const updatedTree = await transitionTreeReviewStatus({
        treeId: parsedTreeId,
        reviewAction: normalizedAction,
        rejectionComment,
        principal,
        enforceAccess: true,
      });

      return NextResponse.json({
        updatedTree,
        trees: await getTreeList({ principal, visibility: normalizedVisibility, enforceAccess: true }),
      });
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
    return NextResponse.json({ error: err.message }, { status: getErrorStatus(err) });
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
        return NextResponse.json({ error: 'Admin role mdsadmins is required' }, { status: 403 });
      }

      await invokePurgeFunction({ action: 'purge-tree', treeId: parsedTreeId });

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
    const message = err instanceof Error ? err.message : 'The request failed';
    const status = getPurgeProxyErrorStatus(err);
    return NextResponse.json({ error: message }, { status });
  }
}