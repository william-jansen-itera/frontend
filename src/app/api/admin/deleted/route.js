import { NextResponse } from 'next/server';
import { parseClientPrincipal } from '@/server/utils/auth';
import { sql, withSqlConnection, getRequiredApplicationIdentifier } from '@/server/utils/sql';
import { hasClientPrincipalRole } from '@/shared/clientPrincipal';
import { deleteNodeAttachmentBlobIfExists } from '@/server/utils/blobStorage';

function assertAdminPrincipal(principal) {
  if (!hasClientPrincipalRole(principal, 'mdsadmin')) {
    throw new Error('Admin role mdsadmin is required');
  }
}

async function getDeletedTreeAttachmentBlobs(applicationIdentifier) {
  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .query(`
      SELECT files.blob_name AS blobName
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.deleted_at IS NOT NULL;
    `);

  return result.recordset;
}

async function getDeletedNodeAttachmentBlobs(applicationIdentifier) {
  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .query(`
      SELECT files.blob_name AS blobName
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND (tn.deleted_at IS NOT NULL OR ti.deleted_at IS NOT NULL);
    `);

  return result.recordset;
}

async function purgeAllDeletedTrees(applicationIdentifier) {
  const attachments = await getDeletedTreeAttachmentBlobs(applicationIdentifier);

  for (const attachment of attachments) {
    await deleteNodeAttachmentBlobIfExists(attachment.blobName);
  }

  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .query(`
      DELETE ti
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.deleted_at IS NOT NULL;
    `);

  return {
    purgedTreeCount: Array.isArray(result.rowsAffected) ? result.rowsAffected.reduce((sum, count) => sum + count, 0) : 0,
    deletedBlobCount: attachments.length,
  };
}

async function purgeAllDeletedNodes(applicationIdentifier) {
  const attachments = await getDeletedNodeAttachmentBlobs(applicationIdentifier);

  for (const attachment of attachments) {
    await deleteNodeAttachmentBlobIfExists(attachment.blobName);
  }

  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .query(`
      DELETE tn
      FROM tree_nodes tn
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND (tn.deleted_at IS NOT NULL OR ti.deleted_at IS NOT NULL);
    `);

  return {
    purgedNodeCount: Array.isArray(result.rowsAffected) ? result.rowsAffected.reduce((sum, count) => sum + count, 0) : 0,
    deletedBlobCount: attachments.length,
  };
}

async function undeleteTree(applicationIdentifier, treeId) {
  const restoredAt = new Date();
  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('restored_at', sql.DateTime2, restoredAt)
    .query(`
      UPDATE ti
      SET deleted_at = NULL,
          updated_at = @restored_at
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id
        AND ti.deleted_at IS NOT NULL;
    `);

  if (!result.rowsAffected[0]) {
    throw new Error('Tree was not found for undelete');
  }

  return {
    restoredTreeId: String(treeId),
  };
}

async function undeleteNode(applicationIdentifier, treeId, nodeId) {
  const restoredAt = new Date();
  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('node_id', sql.Int, Number(nodeId))
    .input('restored_at', sql.DateTime2, restoredAt)
    .query(`
      WITH SelectedNode AS (
        SELECT tn.id, tn.parent_id
        FROM tree_nodes tn
        INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ai.app_identifier = @application_identifier
          AND tn.tree_instance_id = @tree_instance_id
          AND tn.id = @node_id
          AND tn.deleted_at IS NOT NULL
          AND ti.deleted_at IS NULL
      ),
      Ancestors AS (
        SELECT id, parent_id
        FROM SelectedNode

        UNION ALL

        SELECT parent.id, parent.parent_id
        FROM tree_nodes parent
        INNER JOIN Ancestors child ON child.parent_id = parent.id
        WHERE parent.tree_instance_id = @tree_instance_id
      )
      UPDATE tn
      SET deleted_at = NULL,
          updated_at = @restored_at
      FROM tree_nodes tn
      INNER JOIN Ancestors ancestor ON ancestor.id = tn.id
      WHERE tn.tree_instance_id = @tree_instance_id
        AND tn.deleted_at IS NOT NULL;
    `);

  if (!result.rowsAffected[0]) {
    throw new Error('Node was not found for undelete or its tree is still deleted');
  }

  return {
    restoredNodeId: String(nodeId),
    treeId: String(treeId),
  };
}

export async function GET(request) {
  try {
    const principal = parseClientPrincipal(request);
    assertAdminPrincipal(principal);

    const applicationIdentifier = getRequiredApplicationIdentifier();

    return NextResponse.json(await withSqlConnection(async () => {
      const [deletedTreesResult, deletedNodesResult] = await Promise.all([
        new sql.Request()
          .input('application_identifier', sql.NVarChar, applicationIdentifier)
          .query(`
            SELECT
              CAST(ti.id AS VARCHAR(20)) AS id,
              COALESCE(NULLIF(ti.display_name, ''), CONCAT('Tree ', ti.id)) AS name,
              CAST(COALESCE(ti.is_private, 0) AS BIT) AS isPrivate,
              ti.deleted_at AS deletedAt,
              ti.owner_display_name AS ownerDisplayName,
              ti.owner_user_details AS ownerUserDetails
            FROM tree_instance ti
            INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
            WHERE ai.app_identifier = @application_identifier
              AND ti.deleted_at IS NOT NULL
            ORDER BY ti.deleted_at DESC, ti.id DESC;
          `),
        new sql.Request()
          .input('application_identifier', sql.NVarChar, applicationIdentifier)
          .query(`
            SELECT
              deletedNodes.id,
              deletedNodes.treeId,
              deletedNodes.treeDisplayName,
              deletedNodes.nodeId,
              deletedNodes.title,
              deletedNodes.breadcrumb,
              deletedNodes.updatedAt,
              deletedNodes.attachmentCount,
              deletedNodes.hasAttachments,
              deletedNodes.sortPath,
              treeState.deleted_at AS treeDeletedAt,
              CAST(CASE WHEN treeState.deleted_at IS NULL THEN 1 ELSE 0 END AS bit) AS canUndelete
            FROM dbo.vw_tree_search_nodes deletedNodes
            INNER JOIN dbo.tree_instance treeState ON treeState.id = TRY_CAST(deletedNodes.treeId AS INT)
            WHERE deletedNodes.appIdentifier = @application_identifier
              AND deletedNodes.isDeleted = 1
            ORDER BY deletedNodes.updatedAt DESC, deletedNodes.treeId DESC, deletedNodes.sortPath ASC;
          `),
      ]);

      return {
        deletedTrees: deletedTreesResult.recordset.map((row) => ({
          id: String(row.id),
          name: String(row.name ?? '').trim() || `Tree ${row.id}`,
          isPrivate: Boolean(row.isPrivate),
          deletedAt: row.deletedAt ?? null,
          ownerDisplayName: String(row.ownerDisplayName ?? '').trim() || null,
          ownerUserDetails: String(row.ownerUserDetails ?? '').trim() || null,
        })),
        deletedNodes: deletedNodesResult.recordset.map((row) => ({
          id: String(row.id),
          treeId: String(row.treeId),
          treeDisplayName: String(row.treeDisplayName ?? '').trim() || `Tree ${row.treeId}`,
          nodeId: String(row.nodeId),
          title: String(row.title ?? '').trim() || `Node ${row.nodeId}`,
          breadcrumb: String(row.breadcrumb ?? '').trim(),
          updatedAt: row.updatedAt ?? null,
          treeDeletedAt: row.treeDeletedAt ?? null,
          canUndelete: Boolean(row.canUndelete),
          attachmentCount: Number(row.attachmentCount ?? 0),
          hasAttachments: Boolean(row.hasAttachments),
          sortPath: String(row.sortPath ?? ''),
        })),
      };
    }));
  } catch (err) {
    const status = err instanceof Error && err.message === 'Admin role mdsadmin is required' ? 403 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}

export async function DELETE(request) {
  try {
    const principal = parseClientPrincipal(request);
    assertAdminPrincipal(principal);

    const payload = await request.json();
    const action = String(payload?.action ?? '').trim().toLowerCase();
    const applicationIdentifier = getRequiredApplicationIdentifier();

    if (action !== 'purge-all-trees' && action !== 'purge-all-nodes') {
      return NextResponse.json({ error: 'Invalid request, a supported action is required' }, { status: 400 });
    }

    const result = await withSqlConnection(async () => {
      if (action === 'purge-all-trees') {
        return purgeAllDeletedTrees(applicationIdentifier);
      }

      return purgeAllDeletedNodes(applicationIdentifier);
    });

    return NextResponse.json({
      success: true,
      action,
      ...result,
    });
  } catch (err) {
    const status = err instanceof Error && err.message === 'Admin role mdsadmin is required' ? 403 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}

export async function PATCH(request) {
  try {
    const principal = parseClientPrincipal(request);
    assertAdminPrincipal(principal);

    const payload = await request.json();
    const action = String(payload?.action ?? '').trim().toLowerCase();
    const applicationIdentifier = getRequiredApplicationIdentifier();

    if (action === 'undelete-tree') {
      const treeId = Number(payload?.treeId);

      if (!Number.isFinite(treeId)) {
        return NextResponse.json({ error: 'Invalid request, treeId is required' }, { status: 400 });
      }

      const result = await withSqlConnection(async () => undeleteTree(applicationIdentifier, treeId));
      return NextResponse.json({ success: true, action, ...result });
    }

    if (action === 'undelete-node') {
      const treeId = Number(payload?.treeId);
      const nodeId = Number(payload?.nodeId);

      if (!Number.isFinite(treeId) || !Number.isFinite(nodeId)) {
        return NextResponse.json({ error: 'Invalid request, treeId and nodeId are required' }, { status: 400 });
      }

      const result = await withSqlConnection(async () => undeleteNode(applicationIdentifier, treeId, nodeId));
      return NextResponse.json({ success: true, action, ...result });
    }

    return NextResponse.json({ error: 'Invalid request, a supported action is required' }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The request failed';
    const status = message === 'Admin role mdsadmin is required'
      ? 403
      : message.includes('not found for undelete') || message.includes('tree is still deleted')
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}