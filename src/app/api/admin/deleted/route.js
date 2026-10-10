import { NextResponse } from 'next/server';
import { sql, withSqlConnection, getRequiredApplicationIdentifier } from '@/server/utils/sql';
import { restoreNodeAttachmentBlobIfDeleted } from '@/server/utils/blobStorage';
import { getPurgeProxyErrorStatus, invokePurgeFunction } from '@/server/utils/purgeFunctionClient';
import { invokeSecretFunction } from '@/server/utils/secretFunctionClient';
import {
  queryDeletedAttachmentForUndelete,
  queryDeletedNodeAttachmentBlobs,
  queryDeletedNodeForUndelete,
  queryDeletedNodeSecretMetadata,
  queryDeletedTreeAttachmentBlobs,
  queryDeletedTreeForUndelete,
  queryDeletedTreeSecretMetadata,
  queryIndividuallyDeletedAttachments,
} from '@/server/utils/tree/treeRecordRepository';

function getErrorStatus(error, defaultStatus = 500) {
  const status = Number(error?.status);

  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return status;
  }

  return defaultStatus;
}

function normalizeSecretMetadata(value) {
  const candidate = typeof value === 'string'
    ? (() => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })()
    : value;

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }

  const secretName = String(candidate.secretName ?? '').trim();

  if (!secretName) {
    return null;
  }

  return {
    provider: String(candidate.provider ?? 'azure_key_vault').trim() || 'azure_key_vault',
    secretName,
    version: String(candidate.version ?? '').trim() || null,
    vaultUrl: String(candidate.vaultUrl ?? '').trim() || null,
    displayLabel: String(candidate.displayLabel ?? '').trim() || secretName,
  };
}

async function restoreDeletedSecrets(treeId, secretRecords) {
  for (const secretRecord of secretRecords) {
    await invokeSecretFunction({
      action: 'restore-secret',
      treeId: String(treeId),
      nodeId: String(secretRecord.treeNodeId),
      secretMetadata: secretRecord.secretMetadata,
    });
  }
}

async function undeleteTree(applicationIdentifier, treeId) {
  const restoredAt = new Date();
  const treeDeletedAt = (await queryDeletedTreeForUndelete(applicationIdentifier, treeId))?.deletedAt ?? null;

  if (!treeDeletedAt) {
    throw new Error('Tree was not found for undelete');
  }

  const [attachments, secrets] = await Promise.all([
    queryDeletedTreeAttachmentBlobs(applicationIdentifier, treeId, treeDeletedAt),
    queryDeletedTreeSecretMetadata(applicationIdentifier, treeId, treeDeletedAt),
  ]);

  for (const attachment of attachments) {
    await restoreNodeAttachmentBlobIfDeleted(attachment.blobName);
  }

  await restoreDeletedSecrets(
    treeId,
    secrets
      .map((record) => ({
        treeNodeId: record.treeNodeId,
        secretMetadata: normalizeSecretMetadata(record.secretMetadata),
      }))
      .filter((record) => record.secretMetadata),
  );

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
  const nodeDeletedAt = (await queryDeletedNodeForUndelete(applicationIdentifier, treeId, nodeId))?.deletedAt ?? null;

  if (!nodeDeletedAt) {
    throw new Error('Node was not found for undelete or its tree is still deleted');
  }

  const [attachments, secrets] = await Promise.all([
    queryDeletedNodeAttachmentBlobs(applicationIdentifier, treeId, nodeId, nodeDeletedAt),
    queryDeletedNodeSecretMetadata(applicationIdentifier, treeId, nodeId, nodeDeletedAt),
  ]);

  for (const attachment of attachments) {
    await restoreNodeAttachmentBlobIfDeleted(attachment.blobName);
  }

  await restoreDeletedSecrets(
    treeId,
    secrets
      .map((record) => ({
        treeNodeId: record.treeNodeId,
        secretMetadata: normalizeSecretMetadata(record.secretMetadata),
      }))
      .filter((record) => record.secretMetadata),
  );

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
  const attachment = await queryDeletedAttachmentForUndelete(applicationIdentifier, treeId, attachmentId);

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

export async function GET(request) {
  try {
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
        queryIndividuallyDeletedAttachments(applicationIdentifier),
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
    return NextResponse.json({ error: err.message }, { status: getErrorStatus(err) });
  }
}

export async function DELETE(request) {
  try {
    const payload = await request.json();
    const action = String(payload?.action ?? '').trim().toLowerCase();

    if (
      action !== 'purge-all-trees'
      && action !== 'purge-all-nodes'
      && action !== 'purge-all-attachments'
      && action !== 'purge-attachment'
      && action !== 'purge-tree'
      && action !== 'purge-node'
    ) {
      return NextResponse.json({ error: 'Invalid request, a supported action is required' }, { status: 400 });
    }

    if (action === 'purge-attachment') {
      const treeId = Number(payload?.treeId);
      const attachmentId = Number(payload?.attachmentId);

      if (!Number.isFinite(treeId) || !Number.isFinite(attachmentId)) {
        throw new Error('Invalid request, treeId and attachmentId are required');
      }
    }

    if (action === 'purge-tree') {
      const treeId = Number(payload?.treeId);

      if (!Number.isFinite(treeId)) {
        throw new Error('Invalid request, treeId is required');
      }
    }

    if (action === 'purge-node') {
      const treeId = Number(payload?.treeId);
      const nodeId = Number(payload?.nodeId);

      if (!Number.isFinite(treeId) || !Number.isFinite(nodeId)) {
        throw new Error('Invalid request, treeId and nodeId are required');
      }
    }

    const result = await invokePurgeFunction(payload);

    return NextResponse.json({
      success: true,
      action,
      ...result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The request failed';
    const status = getPurgeProxyErrorStatus(err, {
      badRequestIncludes: ['treeId is required', 'treeId and nodeId are required', 'treeId and attachmentId are required', 'not found for purge', 'node is still deleted'],
    });
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PATCH(request) {
  try {
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
    const status = message.includes('not found for undelete') || message.includes('tree is still deleted') || message.includes('node is still deleted')
        ? 400
        : getErrorStatus(err);
    return NextResponse.json({ error: message }, { status });
  }
}