import { NextResponse } from 'next/server';
import { parseClientPrincipal } from '@/server/utils/auth';
import { sql, withSqlConnection, getRequiredApplicationIdentifier } from '@/server/utils/sql';
import { hasClientPrincipalRole } from '@/shared/clientPrincipal';
import {
  deleteNodeAttachmentBlobIfExists,
  restoreNodeAttachmentBlobIfDeleted,
} from '@/server/utils/blobStorage';
import {
  buildAttachmentSearchDocumentId,
  buildTreeNodeSearchDocumentId,
  deleteSearchDocumentsById,
} from '@/server/utils/azureSearch';

function assertAdminPrincipal(principal) {
  if (!hasClientPrincipalRole(principal, 'mdsadmin')) {
    throw new Error('Admin role mdsadmin is required');
  }
}

async function getIndividuallyDeletedAttachments(applicationIdentifier) {
  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .query(`
      SELECT
        CAST(files.id AS VARCHAR(20)) AS id,
        CAST(ti.id AS VARCHAR(20)) AS treeId,
        CAST(tn.id AS VARCHAR(20)) AS nodeId,
        CAST(files.tree_node_id AS VARCHAR(20)) AS treeNodeId,
        COALESCE(NULLIF(ti.display_name, ''), CONCAT('Tree ', ti.id)) AS treeDisplayName,
        COALESCE(NULLIF(nodeSearch.title, ''), CONCAT('Node ', tn.id)) AS nodeTitle,
        COALESCE(NULLIF(files.original_file_name, ''), CONCAT('Attachment ', files.id)) AS fileName,
        COALESCE(nodeSearch.breadcrumb, tn.text, CONCAT('Node ', tn.id)) AS breadcrumb,
        files.deleted_at AS deletedAt,
        files.blob_name AS blobName,
        files.blob_url AS blobUrl
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      LEFT JOIN dbo.vw_tree_search_nodes nodeSearch
        ON nodeSearch.appIdentifier = ai.app_identifier
       AND TRY_CAST(nodeSearch.treeId AS INT) = ti.id
       AND TRY_CAST(nodeSearch.nodeId AS INT) = tn.id
       AND nodeSearch.sourceType = 'node'
      WHERE ai.app_identifier = @application_identifier
        AND files.deleted_at IS NOT NULL
        AND tn.deleted_at IS NULL
        AND ti.deleted_at IS NULL
      ORDER BY files.deleted_at DESC, files.id DESC;
    `);

  return result.recordset;
}

async function getDeletedTreeAttachmentBlobs(applicationIdentifier) {
  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .query(`
      SELECT
        files.blob_name AS blobName,
        files.blob_url AS blobUrl
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.deleted_at IS NOT NULL;
    `);

  return result.recordset;
}

async function getDeletedTreeNodeIds(applicationIdentifier) {
  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .query(`
      SELECT
        CAST(ti.id AS VARCHAR(20)) AS treeId,
        CAST(tn.id AS VARCHAR(20)) AS nodeId
      FROM tree_nodes tn
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
      SELECT
        files.blob_name AS blobName,
        files.blob_url AS blobUrl
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND (tn.deleted_at IS NOT NULL OR ti.deleted_at IS NOT NULL);
    `);

  return result.recordset;
}

async function getDeletedNodeIds(applicationIdentifier) {
  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .query(`
      SELECT
        CAST(ti.id AS VARCHAR(20)) AS treeId,
        CAST(tn.id AS VARCHAR(20)) AS nodeId
      FROM tree_nodes tn
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND (tn.deleted_at IS NOT NULL OR ti.deleted_at IS NOT NULL);
    `);

  return result.recordset;
}

async function purgeAllDeletedTrees(applicationIdentifier) {
  const [nodes, attachments] = await Promise.all([
    getDeletedTreeNodeIds(applicationIdentifier),
    getDeletedTreeAttachmentBlobs(applicationIdentifier),
  ]);
  const searchDocumentIds = [
    ...nodes.map((node) => buildTreeNodeSearchDocumentId(node.treeId, node.nodeId)),
    ...attachments
      .map((attachment) => buildAttachmentSearchDocumentId(attachment.blobUrl))
      .filter(Boolean),
  ];

  await deleteSearchDocumentsById(searchDocumentIds);

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
  const [nodes, attachments] = await Promise.all([
    getDeletedNodeIds(applicationIdentifier),
    getDeletedNodeAttachmentBlobs(applicationIdentifier),
  ]);
  const searchDocumentIds = [
    ...nodes.map((node) => buildTreeNodeSearchDocumentId(node.treeId, node.nodeId)),
    ...attachments
      .map((attachment) => buildAttachmentSearchDocumentId(attachment.blobUrl))
      .filter(Boolean),
  ];

  await deleteSearchDocumentsById(searchDocumentIds);

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
  const treeResult = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .query(`
      SELECT TOP 1 ti.deleted_at AS deletedAt
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id
        AND ti.deleted_at IS NOT NULL;
    `);

  const treeDeletedAt = treeResult.recordset[0]?.deletedAt ?? null;

  if (!treeDeletedAt) {
    throw new Error('Tree was not found for undelete');
  }

  const attachments = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('tree_deleted_at', sql.DateTime2, treeDeletedAt)
    .query(`
      SELECT files.blob_name AS blobName
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id
        AND ti.deleted_at = @tree_deleted_at
        AND files.deleted_at = @tree_deleted_at;
    `);

  for (const attachment of attachments.recordset) {
    await restoreNodeAttachmentBlobIfDeleted(attachment.blobName);
  }

  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('restored_at', sql.DateTime2, restoredAt)
    .input('tree_deleted_at', sql.DateTime2, treeDeletedAt)
    .query(`
      UPDATE ti
      SET deleted_at = NULL,
          updated_at = @restored_at
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id
        AND ti.deleted_at = @tree_deleted_at;

      UPDATE files
      SET deleted_at = NULL,
          updated_at = @restored_at
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id
        AND files.deleted_at = @tree_deleted_at;
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
  const nodeResult = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('node_id', sql.Int, Number(nodeId))
    .query(`
      SELECT TOP 1 tn.deleted_at AS deletedAt
      FROM tree_nodes tn
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND tn.tree_instance_id = @tree_instance_id
        AND tn.id = @node_id
        AND tn.deleted_at IS NOT NULL
        AND ti.deleted_at IS NULL;
    `);

  const nodeDeletedAt = nodeResult.recordset[0]?.deletedAt ?? null;

  if (!nodeDeletedAt) {
    throw new Error('Node was not found for undelete or its tree is still deleted');
  }

  const attachments = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('node_id', sql.Int, Number(nodeId))
    .input('node_deleted_at', sql.DateTime2, nodeDeletedAt)
    .query(`
      WITH Descendants AS (
        SELECT tn.id
        FROM tree_nodes tn
        INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ai.app_identifier = @application_identifier
          AND tn.tree_instance_id = @tree_instance_id
          AND tn.id = @node_id
          AND tn.deleted_at = @node_deleted_at
          AND ti.deleted_at IS NULL

        UNION ALL

        SELECT child.id
        FROM tree_nodes child
        INNER JOIN Descendants parent_descendant ON child.parent_id = parent_descendant.id
        WHERE child.tree_instance_id = @tree_instance_id
          AND child.deleted_at = @node_deleted_at
      )
      SELECT files.blob_name AS blobName
      FROM tree_node_detail_files files
      INNER JOIN Descendants ON Descendants.id = files.tree_node_id
      WHERE files.deleted_at = @node_deleted_at;
    `);

  for (const attachment of attachments.recordset) {
    await restoreNodeAttachmentBlobIfDeleted(attachment.blobName);
  }

  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('node_id', sql.Int, Number(nodeId))
    .input('restored_at', sql.DateTime2, restoredAt)
    .input('node_deleted_at', sql.DateTime2, nodeDeletedAt)
    .query(`
      WITH SelectedNode AS (
        SELECT tn.id, tn.parent_id
        FROM tree_nodes tn
        INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ai.app_identifier = @application_identifier
          AND tn.tree_instance_id = @tree_instance_id
          AND tn.id = @node_id
          AND tn.deleted_at = @node_deleted_at
          AND ti.deleted_at IS NULL
      ),
      Descendants AS (
        SELECT id, parent_id
        FROM SelectedNode

        UNION ALL

        SELECT child.id, child.parent_id
        FROM tree_nodes child
        INNER JOIN Descendants parent_descendant ON child.parent_id = parent_descendant.id
        WHERE child.tree_instance_id = @tree_instance_id
          AND child.deleted_at = @node_deleted_at
      )
      UPDATE tn
      SET deleted_at = NULL,
          updated_at = @restored_at
      FROM tree_nodes tn
      INNER JOIN Descendants descendant ON descendant.id = tn.id
      WHERE tn.tree_instance_id = @tree_instance_id
        AND tn.deleted_at = @node_deleted_at;

      WITH SelectedNode AS (
        SELECT tn.id, tn.parent_id
        FROM tree_nodes tn
        INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ai.app_identifier = @application_identifier
          AND tn.tree_instance_id = @tree_instance_id
          AND tn.id = @node_id
          AND ti.deleted_at IS NULL
      ),
      Descendants AS (
        SELECT id, parent_id
        FROM SelectedNode

        UNION ALL

        SELECT child.id, child.parent_id
        FROM tree_nodes child
        INNER JOIN Descendants parent_descendant ON child.parent_id = parent_descendant.id
        WHERE child.tree_instance_id = @tree_instance_id
      )
      UPDATE files
      SET deleted_at = NULL,
          updated_at = @restored_at
      FROM tree_node_detail_files files
      INNER JOIN Descendants descendant ON descendant.id = files.tree_node_id
      WHERE files.deleted_at = @node_deleted_at;
    `);

  if (!result.rowsAffected[0]) {
    throw new Error('Node was not found for undelete or its tree is still deleted');
  }

  return {
    restoredNodeId: String(nodeId),
    treeId: String(treeId),
  };
}

async function undeleteAttachment(applicationIdentifier, treeId, attachmentId) {
  const attachmentResult = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('attachment_id', sql.Int, Number(attachmentId))
    .query(`
      SELECT TOP 1
        files.blob_name AS blobName,
        files.deleted_at AS deletedAt,
        CAST(files.id AS VARCHAR(20)) AS attachmentId,
        CAST(tn.id AS VARCHAR(20)) AS nodeId
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id
        AND files.id = @attachment_id
        AND files.deleted_at IS NOT NULL
        AND tn.deleted_at IS NULL
        AND ti.deleted_at IS NULL;
    `);

  const attachment = attachmentResult.recordset[0] ?? null;

  if (!attachment) {
    throw new Error('Attachment was not found for undelete or its node is still deleted');
  }

  const restoredBlob = await restoreNodeAttachmentBlobIfDeleted(attachment.blobName);

  if (!restoredBlob) {
    throw new Error('Attachment blob could not be restored for undelete');
  }

  const restoredAt = new Date();
  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('attachment_id', sql.Int, Number(attachmentId))
    .input('restored_at', sql.DateTime2, restoredAt)
    .query(`
      UPDATE files
      SET deleted_at = NULL,
          updated_at = @restored_at
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id
        AND files.id = @attachment_id
        AND files.deleted_at IS NOT NULL
        AND tn.deleted_at IS NULL
        AND ti.deleted_at IS NULL;
    `);

  if (!result.rowsAffected[0]) {
    throw new Error('Attachment was not found for undelete or its node is still deleted');
  }

  return {
    restoredAttachmentId: String(attachmentId),
    treeId: String(treeId),
    nodeId: String(attachment.nodeId),
  };
}

async function purgeAttachment(applicationIdentifier, treeId, attachmentId) {
  const attachmentResult = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('attachment_id', sql.Int, Number(attachmentId))
    .query(`
      SELECT TOP 1
        files.blob_name AS blobName,
        files.blob_url AS blobUrl,
        CAST(files.id AS VARCHAR(20)) AS attachmentId,
        CAST(tn.id AS VARCHAR(20)) AS nodeId
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id
        AND files.id = @attachment_id
        AND files.deleted_at IS NOT NULL
        AND tn.deleted_at IS NULL
        AND ti.deleted_at IS NULL;
    `);

  const attachment = attachmentResult.recordset[0] ?? null;

  if (!attachment) {
    throw new Error('Attachment was not found for purge or its node is still deleted');
  }

  const documentId = buildAttachmentSearchDocumentId(attachment.blobUrl);

  if (documentId) {
    await deleteSearchDocumentsById([documentId]);
  }

  await deleteNodeAttachmentBlobIfExists(attachment.blobName);

  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('attachment_id', sql.Int, Number(attachmentId))
    .query(`
      DELETE files
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id
        AND files.id = @attachment_id
        AND files.deleted_at IS NOT NULL
        AND tn.deleted_at IS NULL
        AND ti.deleted_at IS NULL;
    `);

  if (!result.rowsAffected[0]) {
    throw new Error('Attachment was not found for purge or its node is still deleted');
  }

  return {
    purgedAttachmentId: String(attachmentId),
    treeId: String(treeId),
    nodeId: String(attachment.nodeId),
  };
}

export async function GET(request) {
  try {
    const principal = parseClientPrincipal(request);
    assertAdminPrincipal(principal);

    const applicationIdentifier = getRequiredApplicationIdentifier();

    return NextResponse.json(await withSqlConnection(async () => {
      const [deletedTreesResult, deletedNodesResult, deletedAttachments] = await Promise.all([
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
              deletedNodes.updatedByUserDetails,
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
        getIndividuallyDeletedAttachments(applicationIdentifier),
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
          updatedByUserDetails: String(row.updatedByUserDetails ?? '').trim() || null,
          updatedAt: row.updatedAt ?? null,
          treeDeletedAt: row.treeDeletedAt ?? null,
          canUndelete: Boolean(row.canUndelete),
          attachmentCount: Number(row.attachmentCount ?? 0),
          hasAttachments: Boolean(row.hasAttachments),
          sortPath: String(row.sortPath ?? ''),
        })),
        deletedAttachments: deletedAttachments.map((row) => ({
          id: String(row.id),
          treeId: String(row.treeId),
          nodeId: String(row.nodeId),
          treeNodeId: String(row.treeNodeId),
          treeDisplayName: String(row.treeDisplayName ?? '').trim() || `Tree ${row.treeId}`,
          nodeTitle: String(row.nodeTitle ?? '').trim() || `Node ${row.nodeId}`,
          fileName: String(row.fileName ?? '').trim() || `Attachment ${row.id}`,
          breadcrumb: String(row.breadcrumb ?? '').trim(),
          deletedAt: row.deletedAt ?? null,
          blobName: String(row.blobName ?? '').trim() || null,
          blobUrl: String(row.blobUrl ?? '').trim() || null,
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

    if (action !== 'purge-all-trees' && action !== 'purge-all-nodes' && action !== 'purge-attachment') {
      return NextResponse.json({ error: 'Invalid request, a supported action is required' }, { status: 400 });
    }

    const result = await withSqlConnection(async () => {
      if (action === 'purge-all-trees') {
        return purgeAllDeletedTrees(applicationIdentifier);
      }

      if (action === 'purge-attachment') {
        const treeId = Number(payload?.treeId);
        const attachmentId = Number(payload?.attachmentId);

        if (!Number.isFinite(treeId) || !Number.isFinite(attachmentId)) {
          throw new Error('Invalid request, treeId and attachmentId are required');
        }

        return purgeAttachment(applicationIdentifier, treeId, attachmentId);
      }

      return purgeAllDeletedNodes(applicationIdentifier);
    });

    return NextResponse.json({
      success: true,
      action,
      ...result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The request failed';
    const status = message === 'Admin role mdsadmin is required'
      ? 403
      : message.includes('treeId and attachmentId are required') || message.includes('not found for purge') || message.includes('node is still deleted')
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
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

    if (action === 'undelete-attachment') {
      const treeId = Number(payload?.treeId);
      const attachmentId = Number(payload?.attachmentId);

      if (!Number.isFinite(treeId) || !Number.isFinite(attachmentId)) {
        return NextResponse.json({ error: 'Invalid request, treeId and attachmentId are required' }, { status: 400 });
      }

      const result = await withSqlConnection(async () => undeleteAttachment(applicationIdentifier, treeId, attachmentId));
      return NextResponse.json({ success: true, action, ...result });
    }

    return NextResponse.json({ error: 'Invalid request, a supported action is required' }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The request failed';
    const status = message === 'Admin role mdsadmin is required'
      ? 403
      : message.includes('not found for undelete') || message.includes('tree is still deleted') || message.includes('node is still deleted')
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}