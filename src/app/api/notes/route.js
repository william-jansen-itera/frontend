
import { NextResponse } from 'next/server';
import { parseClientPrincipal } from '@/server/utils/auth';
import { getPurgeProxyErrorStatus, invokePurgeFunction } from '@/server/utils/purgeFunctionClient';
import { hasClientPrincipalRole } from '@/shared/clientPrincipal';
import {
  CreateTreeNode,
  getNodeDetails,
  getTreeData,
  getTreeSettings,
  UpdateTreeNodes,
  UpdateTreeNodeOpenState,
  UpdateTreeNodeOpenStates,
} from '@/server/utils/tree/treeRecordRepository';
import {
  createLeafNodeFromChat,
  createTreeNodeAttachment,
  deleteAttachmentMetadataRecord,
  deleteTreeNode,
  generateChildrenForNode,
  generateNotesForNode,
  normalizeUpdatedByMetadata,
  previewLeafFromChat,
  revealTreeNodeSecret,
  transitionAttachmentReviewStatus,
  transitionTreeNodeReviewStatus,
  updateTreeNodeDetails,
} from '@/server/utils/tree/treeMutationService';
import { assertTreeAccess, getTreeList } from '@/server/utils/tree/treeCatalog';

function getErrorStatus(error, defaultStatus = 500) {
  const status = Number(error?.status);

  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return status;
  }

  return defaultStatus;
}

async function assertReadableTreeForRequest(request, treeId, visibility = 'both') {
  return assertTreeAccess(treeId, {
    principal: parseClientPrincipal(request),
    visibility,
  });
}

async function assertWritableTreeForRequest(request, treeId) {
  return assertTreeAccess(treeId, {
    principal: parseClientPrincipal(request),
    visibility: 'both',
    requireWriteAccess: true,
  });
}


function parseToolTreeId(toolName) {
  const match = String(toolName ?? '').trim().match(/_(\d+)$/);
  return match ? match[1] : '';
}


export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const treeIdParam = searchParams.get('treeId');
  const includeParam = searchParams.get('include');
  const nodeIdParam = searchParams.get('id');
  const visibility = searchParams.get('visibility') ?? 'both';

  try {
    if (!treeIdParam) {
      return NextResponse.json(await getTreeList({
        principal: parseClientPrincipal(request),
        visibility,
        enforceAccess: true,
      }));
    }

    await assertReadableTreeForRequest(request, treeIdParam, visibility);

    if (includeParam === 'settings') {
      return NextResponse.json(await getTreeSettings(treeIdParam));
    }

    if (includeParam === 'details') {
      if (!nodeIdParam) {
        return NextResponse.json({ error: 'Invalid request, id is required for node details' }, { status: 400 });
      }

      const details = await getNodeDetails(treeIdParam, nodeIdParam);
      if (!details) {
        return NextResponse.json({ error: 'Node was not found for the selected tree' }, { status: 404 });
      }

      return NextResponse.json(details);
    }

    return NextResponse.json(await getTreeData(treeIdParam));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: getErrorStatus(err) });
  }
}

export async function POST(request) {
  try {
    const principal = parseClientPrincipal(request);
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const treeId = formData.get('treeId');
      const nodeId = formData.get('nodeId');
      const files = formData
        .getAll('files')
        .filter((file) => typeof file?.arrayBuffer === 'function' && file.size > 0);

      if (!treeId || !nodeId || files.length === 0) {
        return NextResponse.json({ error: 'Invalid upload request, treeId, nodeId, and files are required' }, { status: 400 });
      }

      await assertWritableTreeForRequest(request, treeId);

      return NextResponse.json(await createTreeNodeAttachment({
        treeInstanceId: parseInt(String(treeId), 10),
        nodeId: parseInt(String(nodeId), 10),
        files,
        updatedBy: normalizeUpdatedByMetadata(principal),
      }));
    }

    const {
      action,
      parentId,
      treeId,
      name,
      nodeId,
      toolName,
      originalQuestion,
      broaderAnswer,
      placementMode,
      selectedAnchorNodeId,
      selectedAnchorBreadcrumb,
      generatedPathTitles,
      plannedLeafParentBreadcrumb,
      generatedLeafTitle,
    } = await request.json();

    if (action === 'create-leaf-from-chat') {
      const resolvedTreeId = treeId ? String(treeId) : parseToolTreeId(toolName);

      if (!resolvedTreeId) {
        return NextResponse.json({ error: 'A valid tree context is required for the chat add action.' }, { status: 400 });
      }

      await assertWritableTreeForRequest(request, resolvedTreeId);

      return NextResponse.json(await createLeafNodeFromChat({
        treeInstanceId: parseInt(resolvedTreeId, 10),
        principal,
        toolName,
        originalQuestion,
        broaderAnswer,
        placementMode,
        selectedAnchorNodeId,
        selectedAnchorBreadcrumb,
        generatedPathTitles,
        plannedLeafParentBreadcrumb,
        generatedLeafTitle,
      }));
    }

    if (action === 'preview-leaf-from-chat') {
      const resolvedTreeId = treeId ? String(treeId) : parseToolTreeId(toolName);

      if (!resolvedTreeId) {
        return NextResponse.json({ error: 'A valid tree context is required for the chat add action.' }, { status: 400 });
      }

      await assertReadableTreeForRequest(request, resolvedTreeId);

      return NextResponse.json(await previewLeafFromChat({
        treeInstanceId: parseInt(resolvedTreeId, 10),
        originalQuestion,
        broaderAnswer,
      }));
    }

    if (!treeId) {
      return NextResponse.json({ error: 'Invalid request, treeId is required' }, { status: 400 });
    }

    await assertWritableTreeForRequest(request, treeId);

    if (action === 'generate-children') {
      if (!nodeId) {
        return NextResponse.json({ error: 'Invalid request, nodeId is required for child generation' }, { status: 400 });
      }

      return NextResponse.json(await generateChildrenForNode(
        parseInt(String(treeId), 10),
        parseInt(String(nodeId), 10),
      ));
    }

    if (action === 'generate-notes') {
      if (!nodeId) {
        return NextResponse.json({ error: 'Invalid request, nodeId is required for note generation' }, { status: 400 });
      }

      return NextResponse.json(await generateNotesForNode(
        parseInt(String(treeId), 10),
        parseInt(String(nodeId), 10),
      ));
    }

    return NextResponse.json(await CreateTreeNode({
      parentId: parentId === null || parentId === undefined ? null : parseInt(parentId, 10),
      treeInstanceId: parseInt(treeId, 10),
      name: name?.trim() || 'New node',
    }));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: getErrorStatus(err) });
  }
}

export async function PUT(request) {
  try {
    const { treeId, nodes } = await request.json();

    if (!treeId || !Array.isArray(nodes)) {
      return NextResponse.json({ error: 'Invalid request, treeId and nodes are required' }, { status: 400 });
    }

    await assertWritableTreeForRequest(request, treeId);

    await UpdateTreeNodes(parseInt(treeId), nodes);
    return NextResponse.json(await getTreeData(treeId));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: getErrorStatus(err) });
  }
}

export async function PATCH(request) {
  try {
    const principal = parseClientPrincipal(request);
    const {
      action,
      id,
      treeId,
      isExpanded,
      expandedNodeIds,
      name,
      notes,
      isSecret,
      secretValue,
      secretMetadata,
      attachmentId,
      rejectionComment,
    } = await request.json();
    const normalizedAction = String(action ?? '').trim().toLowerCase();

    if (!treeId) {
      return NextResponse.json({ error: 'Invalid request, treeId is required' }, { status: 400 });
    }

    await assertWritableTreeForRequest(request, treeId);

    if (normalizedAction === 'reveal-secret') {
      if (id === undefined) {
        return NextResponse.json({ error: 'Invalid request, id is required for secret reveal' }, { status: 400 });
      }

      return NextResponse.json(await revealTreeNodeSecret(parseInt(treeId, 10), parseInt(id, 10)));
    }

    if (normalizedAction === 'submit-node-review' || normalizedAction === 'unsubmit-node-review' || normalizedAction === 'approve-node-review' || normalizedAction === 'reject-node-review') {
      if (id === undefined) {
        return NextResponse.json({ error: 'Invalid request, id is required for node review' }, { status: 400 });
      }

      return NextResponse.json(await transitionTreeNodeReviewStatus({
        treeInstanceId: parseInt(treeId, 10),
        nodeId: parseInt(id, 10),
        principal,
        reviewAction: normalizedAction.replace('-node-review', ''),
        rejectionComment,
      }));
    }

    if (normalizedAction === 'submit-attachment-review' || normalizedAction === 'unsubmit-attachment-review' || normalizedAction === 'approve-attachment-review' || normalizedAction === 'reject-attachment-review') {
      if (attachmentId === undefined) {
        return NextResponse.json({ error: 'Invalid request, attachmentId is required for attachment review' }, { status: 400 });
      }

      return NextResponse.json({
        details: await transitionAttachmentReviewStatus({
          treeInstanceId: parseInt(treeId, 10),
          attachmentId: parseInt(attachmentId, 10),
          principal,
          reviewAction: normalizedAction.replace('-attachment-review', ''),
          rejectionComment,
        }),
      });
    }

    if (Array.isArray(expandedNodeIds)) {
      await UpdateTreeNodeOpenStates(parseInt(treeId, 10), expandedNodeIds, true);
      return NextResponse.json({ success: true });
    }

    if (id === undefined) {
      return NextResponse.json({ error: 'Invalid request, id is required' }, { status: 400 });
    }

    if (typeof isExpanded === 'boolean') {
      await UpdateTreeNodeOpenState(parseInt(treeId), id, isExpanded);
      return NextResponse.json({ success: true });
    }

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Invalid request, name is required when saving node details' }, { status: 400 });
    }

    return NextResponse.json(await updateTreeNodeDetails(parseInt(treeId), parseInt(id), {
      name,
      notes: typeof notes === 'string' ? notes : '',
      isSecret: Boolean(isSecret),
      secretValue: typeof secretValue === 'string' ? secretValue : '',
      secretMetadata,
      updatedBy: normalizeUpdatedByMetadata(principal),
    }));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: getErrorStatus(err) });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const principal = parseClientPrincipal(request);
    const idParam = searchParams.get('id');
    const treeIdParam = searchParams.get('treeId');
    const attachmentIdParam = searchParams.get('attachmentId');
    const shouldPurge = String(searchParams.get('purge') ?? '').trim().toLowerCase() === 'true';

    if (attachmentIdParam) {
      if (!treeIdParam) {
        return NextResponse.json({ error: 'Invalid request, treeId is required for attachment delete' }, { status: 400 });
      }

      await assertWritableTreeForRequest(request, treeIdParam);

      return NextResponse.json(await deleteAttachmentMetadataRecord(
        parseInt(treeIdParam, 10),
        parseInt(attachmentIdParam, 10),
        normalizeUpdatedByMetadata(principal),
      ));
    }

    if (!idParam || !treeIdParam) {
      return NextResponse.json({ error: 'Invalid request, id and treeId are required' }, { status: 400 });
    }

    if (!shouldPurge) {
      await assertWritableTreeForRequest(request, treeIdParam);
    } else if (!hasClientPrincipalRole(principal, 'mdsadmins')) {
      return NextResponse.json({ error: 'Admin role mdsadmins is required' }, { status: 403 });
    }

    const treeInstanceId = parseInt(treeIdParam, 10);
    const nodeId = parseInt(idParam, 10);

    if (shouldPurge) {
      const result = await invokePurgeFunction({
        action: 'purge-node',
        treeId: treeInstanceId,
        nodeId,
      });

      return NextResponse.json(result);
    }

    return NextResponse.json(await deleteTreeNode({ id: nodeId, treeInstanceId }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The request failed';
    const status = getPurgeProxyErrorStatus(err, {
      forbiddenMessages: ['Admin role mdsadmins is required'],
    });
    return NextResponse.json({ error: message }, { status });
  }
}

