import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';

const REVIEW_STATUS_DRAFT = 'draft';
const REVIEW_STATUS_SUBMITTED = 'submitted';
const REVIEW_STATUS_APPROVED = 'approved';
const REVIEW_STATUS_REJECTED = 'rejected';
const SECRET_PROVIDER_AZURE_KEY_VAULT = 'azure_key_vault';
const MASKED_SECRET_VALUE = 'Stored secret';
const DEFAULT_SECRET_REFERENCE_LABEL = 'Stored Key Vault secret';

export function createSqlRequest(transaction = null) {
  return transaction ? new sql.Request(transaction) : new sql.Request();
}

function normalizeReviewStatus(value, fallback = REVIEW_STATUS_DRAFT) {
  const normalizedValue = String(value ?? '').trim().toLowerCase();

  if (
    normalizedValue === REVIEW_STATUS_DRAFT
    || normalizedValue === REVIEW_STATUS_SUBMITTED
    || normalizedValue === REVIEW_STATUS_APPROVED
    || normalizedValue === REVIEW_STATUS_REJECTED
  ) {
    return normalizedValue;
  }

  return fallback;
}

function normalizeRejectionComment(value, { required = false } = {}) {
  const normalizedValue = String(value ?? '').trim();

  if (!normalizedValue) {
    if (required) {
      throw new Error('A rejection comment is required');
    }

    return null;
  }

  return normalizedValue.slice(0, 2000);
}

function getEffectiveReviewStatus(value, approvalEnabled) {
  if (!approvalEnabled) {
    return REVIEW_STATUS_DRAFT;
  }

  return normalizeReviewStatus(value, REVIEW_STATUS_DRAFT);
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

  const provider = String(candidate.provider ?? SECRET_PROVIDER_AZURE_KEY_VAULT).trim() || SECRET_PROVIDER_AZURE_KEY_VAULT;
  const secretName = String(candidate.secretName ?? '').trim();
  const version = String(candidate.version ?? '').trim() || null;
  const vaultUrl = String(candidate.vaultUrl ?? '').trim() || null;
  const displayLabel = String(candidate.displayLabel ?? '').trim() || secretName || null;

  if (!secretName) {
    return null;
  }

  return {
    provider,
    secretName,
    version,
    vaultUrl,
    displayLabel,
  };
}

function buildSecretReference(secretMetadata) {
  const normalizedMetadata = normalizeSecretMetadata(secretMetadata);

  if (!normalizedMetadata) {
    return null;
  }

  return {
    provider: normalizedMetadata.provider,
    version: normalizedMetadata.version,
    displayLabel: DEFAULT_SECRET_REFERENCE_LABEL,
    hasStoredSecret: true,
  };
}

export async function queryTreeData(treeInstanceId) {
  const query = `WITH RecursiveTree AS (
      SELECT
        tn.id,
        tn.parent_id,
        tn.text,
        tn.is_leaf_node,
        tn.is_expanded,
        tn.draggable,
        tn.sort_order,
        CAST(COALESCE(ti.approval_enabled, 0) AS BIT) AS approvalEnabled,
        CAST(CASE WHEN COALESCE(ti.approval_enabled, 0) = 1 THEN COALESCE(tn.review_status, '${REVIEW_STATUS_DRAFT}') ELSE '${REVIEW_STATUS_DRAFT}' END AS NVARCHAR(20)) AS reviewStatus,
        CAST(RIGHT(REPLICATE('0', 3) + CAST(tn.sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS path,
        0 AS _depth
      FROM tree_nodes tn
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      WHERE tn.tree_instance_id = @tree_instance_id
        AND tn.deleted_at IS NULL
        AND tn.parent_id IS NULL
      UNION ALL
      SELECT
        t.id,
        t.parent_id,
        t.text,
        t.is_leaf_node,
        t.is_expanded,
        t.draggable,
        t.sort_order,
        rt.approvalEnabled,
        CAST(CASE WHEN rt.approvalEnabled = 1 THEN COALESCE(t.review_status, '${REVIEW_STATUS_DRAFT}') ELSE '${REVIEW_STATUS_DRAFT}' END AS NVARCHAR(20)) AS reviewStatus,
        CAST(rt.path + '-' + RIGHT(REPLICATE('0', 3) + CAST(t.sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS path,
        rt._depth + 1 AS _depth
      FROM tree_nodes t
      INNER JOIN RecursiveTree rt ON t.parent_id = rt.id
      WHERE t.tree_instance_id = @tree_instance_id
        AND t.deleted_at IS NULL
    )
    SELECT
      CAST(id AS VARCHAR(10)) AS id,
      CAST(parent_id AS VARCHAR(10)) AS parent,
      text AS name,
      is_leaf_node AS isLeafNode,
      is_expanded AS isExpanded,
      draggable,
      sort_order,
      reviewStatus,
      _depth,
      path
    FROM RecursiveTree
    ORDER BY path;`;

  const result = await new sql.Request()
    .input('tree_instance_id', sql.Int, parseInt(treeInstanceId, 10))
    .query(query);

  return result.recordset;
}

export async function getTreeData(treeInstanceId) {
  return withSqlConnection(async () => queryTreeData(treeInstanceId));
}

export async function queryTreeNode(treeInstanceId, nodeId, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, parseInt(treeInstanceId, 10))
    .input('id', sql.Int, parseInt(nodeId, 10))
    .query(`
      SELECT TOP 1
        CAST(tn.id AS VARCHAR(10)) AS id,
        tn.text AS name,
        tn.is_leaf_node AS isLeafNode,
        CAST(CASE WHEN COALESCE(ti.approval_enabled, 0) = 1 THEN COALESCE(tn.review_status, '${REVIEW_STATUS_DRAFT}') ELSE '${REVIEW_STATUS_DRAFT}' END AS NVARCHAR(20)) AS reviewStatus,
        tn.submitted_at AS submittedAt,
        tn.submitted_by_user_details AS submittedByUserDetails,
        tn.reviewed_at AS reviewedAt,
        tn.reviewed_by_user_details AS reviewedByUserDetails,
        tn.rejection_comment AS rejectionComment
      FROM tree_nodes tn
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      WHERE tn.tree_instance_id = @tree_instance_id AND tn.id = @id AND tn.deleted_at IS NULL;
    `);

  return result.recordset[0] ?? null;
}

export async function queryNodeDetails(treeInstanceId, nodeId, transaction = null, knownNode = null) {
  const node = knownNode ?? await queryTreeNode(treeInstanceId, nodeId, transaction);
  if (!node) {
    return null;
  }

  if (!node.isLeafNode) {
    return {
      id: node.id,
      name: node.name,
      notes: '',
      isSecret: false,
      secretMetadata: null,
      maskedSecretValue: null,
      updatedAt: null,
      updatedByUserDetails: null,
      attachments: [],
      isLeafNode: false,
      reviewStatus: getEffectiveReviewStatus(node.reviewStatus, true),
      submittedAt: node.submittedAt ?? null,
      submittedByUserDetails: node.submittedByUserDetails ?? null,
      reviewedAt: node.reviewedAt ?? null,
      reviewedByUserDetails: node.reviewedByUserDetails ?? null,
      rejectionComment: normalizeRejectionComment(node.rejectionComment),
    };
  }

  const detailResult = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, parseInt(treeInstanceId, 10))
    .input('id', sql.Int, parseInt(nodeId, 10))
    .query(`
      SELECT
        CAST(tn.id AS VARCHAR(10)) AS id,
        tn.text AS name,
        ISNULL(tnd.notes, '') AS notes,
        CAST(COALESCE(tnd.is_secret, 0) AS BIT) AS isSecret,
        tnd.secret_metadata AS secretMetadata,
        CAST(CASE WHEN COALESCE(ti.approval_enabled, 0) = 1 THEN COALESCE(tn.review_status, '${REVIEW_STATUS_DRAFT}') ELSE '${REVIEW_STATUS_DRAFT}' END AS NVARCHAR(20)) AS reviewStatus,
        tn.submitted_at AS submittedAt,
        tn.submitted_by_user_details AS submittedByUserDetails,
        tn.reviewed_at AS reviewedAt,
        tn.reviewed_by_user_details AS reviewedByUserDetails,
        tn.rejection_comment AS rejectionComment,
        tnd.updated_at AS updatedAt,
        tnd.updated_by_user_details AS updatedByUserDetails
      FROM tree_nodes tn
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      LEFT JOIN tree_node_details tnd ON tnd.tree_node_id = tn.id
      WHERE tn.tree_instance_id = @tree_instance_id AND tn.id = @id AND tn.deleted_at IS NULL;
    `);

  const details = detailResult.recordset[0] ?? null;
  if (!details) {
    return {
      id: node.id,
      name: node.name,
      notes: '',
      isSecret: false,
      secretMetadata: null,
      maskedSecretValue: null,
      updatedAt: null,
      updatedByUserDetails: null,
      attachments: [],
      isLeafNode: true,
      reviewStatus: REVIEW_STATUS_DRAFT,
      submittedAt: null,
      submittedByUserDetails: null,
      reviewedAt: null,
      reviewedByUserDetails: null,
      rejectionComment: null,
    };
  }

  const attachmentResult = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, parseInt(treeInstanceId, 10))
    .input('id', sql.Int, parseInt(nodeId, 10))
    .query(`
      SELECT
        CAST(files.id AS VARCHAR(10)) AS id,
        files.original_file_name AS fileName,
        files.content_type AS contentType,
        files.byte_size AS byteSize,
        files.blob_name AS blobName,
        files.blob_url AS blobUrl,
        CAST(CASE WHEN COALESCE(ti.approval_enabled, 0) = 1 THEN COALESCE(files.review_status, '${REVIEW_STATUS_DRAFT}') ELSE '${REVIEW_STATUS_DRAFT}' END AS NVARCHAR(20)) AS reviewStatus,
        files.submitted_at AS submittedAt,
        files.submitted_by_user_details AS submittedByUserDetails,
        files.reviewed_at AS reviewedAt,
        files.reviewed_by_user_details AS reviewedByUserDetails,
        files.rejection_comment AS rejectionComment,
        files.created_at AS createdAt,
        files.updated_at AS updatedAt,
        files.updated_by_user_details AS updatedByUserDetails
      FROM tree_node_detail_files files
      INNER JOIN tree_node_details details ON details.tree_node_id = files.tree_node_id
      INNER JOIN tree_nodes tn ON tn.id = details.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      WHERE tn.tree_instance_id = @tree_instance_id AND tn.id = @id AND tn.deleted_at IS NULL AND files.deleted_at IS NULL
      ORDER BY files.created_at DESC, files.id DESC;
    `);

  const secretMetadata = buildSecretReference(details.secretMetadata);

  return {
    ...details,
    isLeafNode: true,
    isSecret: Boolean(details.isSecret),
    secretMetadata,
    maskedSecretValue: Boolean(details.isSecret) ? MASKED_SECRET_VALUE : null,
    attachments: attachmentResult.recordset,
  };
}

export async function queryTreeNodeDetailRecord(treeInstanceId, nodeId, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, parseInt(treeInstanceId, 10))
    .input('id', sql.Int, parseInt(nodeId, 10))
    .query(`
      SELECT TOP 1
        ISNULL(tnd.notes, '') AS notes,
        CAST(COALESCE(tnd.is_secret, 0) AS BIT) AS isSecret,
        tnd.secret_metadata AS secretMetadata
      FROM tree_nodes tn
      LEFT JOIN tree_node_details tnd ON tnd.tree_node_id = tn.id
      WHERE tn.tree_instance_id = @tree_instance_id
        AND tn.id = @id
        AND tn.deleted_at IS NULL;
    `);

  return result.recordset[0] ?? null;
}

export async function getNodeDetails(treeInstanceId, nodeId) {
  return withSqlConnection(async () => queryNodeDetails(treeInstanceId, nodeId));
}

export async function getTreeSettings(treeInstanceId) {
  const query = `
    SELECT
      setting_key AS settingKey,
      setting_value AS settingValue
    FROM tree_setting
    WHERE tree_instance_id = @tree_instance_id
    ORDER BY setting_key;`;

  return withSqlConnection(async () => {
    const result = await new sql.Request()
      .input('tree_instance_id', sql.Int, parseInt(treeInstanceId, 10))
      .query(query);

    return result.recordset;
  });
}

export async function queryTreeSummary(treeInstanceId, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, parseInt(treeInstanceId, 10))
    .query(`
      SELECT TOP 1 COALESCE(NULLIF(display_name, ''), CONCAT('Tree ', id)) AS treeName
      FROM tree_instance
      WHERE id = @tree_instance_id AND deleted_at IS NULL;
    `);

  return {
    treeName: String(result.recordset[0]?.treeName ?? '').trim() || `Tree ${treeInstanceId}`,
  };
}

export async function getTreeMaxDepth(treeInstanceId) {
  const result = await new sql.Request()
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .query(`
      SELECT TOP 1 TRY_CAST(setting_value AS INT) AS maxDepth
      FROM tree_setting
      WHERE tree_instance_id = @tree_instance_id
        AND setting_key = 'nodes.max_depth';
    `);

  return Number(result.recordset[0]?.maxDepth);
}

export async function getTreeMaxDepthForRequest(treeInstanceId, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .query(`
      SELECT TOP 1 TRY_CAST(setting_value AS INT) AS maxDepth
      FROM tree_setting
      WHERE tree_instance_id = @tree_instance_id
        AND setting_key = 'nodes.max_depth';
    `);

  return Number(result.recordset[0]?.maxDepth);
}

export async function getTreeCreateContext(treeInstanceId, parentId, transaction = null) {
  const query = `WITH RecursiveTree AS (
      SELECT
        id,
        parent_id,
        0 AS depth
      FROM tree_nodes
      WHERE tree_instance_id = @tree_instance_id
        AND deleted_at IS NULL
        AND parent_id IS NULL
      UNION ALL
      SELECT
        t.id,
        t.parent_id,
        rt.depth + 1 AS depth
      FROM tree_nodes t
      INNER JOIN RecursiveTree rt ON t.parent_id = rt.id
      WHERE t.tree_instance_id = @tree_instance_id
        AND t.deleted_at IS NULL
    )
    SELECT
      parent_node.is_leaf_node AS isLeafNode,
      parent_depth.depth AS parentDepth,
      TRY_CAST(setting_row.setting_value AS INT) AS maxDepth
    FROM tree_nodes parent_node
    INNER JOIN RecursiveTree parent_depth ON parent_depth.id = parent_node.id
    OUTER APPLY (
      SELECT TOP 1 setting_value
      FROM tree_setting
      WHERE tree_instance_id = @tree_instance_id
        AND setting_key = 'nodes.max_depth'
    ) setting_row
    WHERE parent_node.tree_instance_id = @tree_instance_id
      AND parent_node.deleted_at IS NULL
      AND parent_node.id = @parent_id;`;

  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('parent_id', sql.Int, parentId)
    .query(query);

  return result.recordset[0] ?? null;
}

export async function ensureTreeNodeDetailsRow(treeNodeId, transaction = null) {
  await createSqlRequest(transaction)
    .input('tree_node_id', sql.Int, treeNodeId)
    .query(`
      MERGE tree_node_details AS target
      USING (SELECT @tree_node_id AS tree_node_id) AS source
        ON target.tree_node_id = source.tree_node_id
      WHEN NOT MATCHED THEN
        INSERT (tree_node_id, notes, created_at, updated_at)
        VALUES (@tree_node_id, '', SYSUTCDATETIME(), SYSUTCDATETIME());
    `);
}

export async function createTreeNodeRecord({ parentId, treeInstanceId, name, ensureLeafDetails = false, transaction = null }) {
  const isRootInsert = parentId === null || parentId === undefined;
  let nextDepth = 0;
  let maxDepth;

  if (isRootInsert) {
    maxDepth = await getTreeMaxDepthForRequest(treeInstanceId, transaction);
  } else {
    const createContext = await getTreeCreateContext(treeInstanceId, parentId, transaction);
    if (!createContext) {
      throw new Error('Parent node was not found for the selected tree');
    }

    if (createContext.isLeafNode) {
      throw new Error('Cannot add a child node to a leaf node');
    }

    const parentDepth = Number(createContext.parentDepth);
    maxDepth = Number(createContext.maxDepth);
    nextDepth = parentDepth + 1;

    if (Number.isFinite(maxDepth) && nextDepth > maxDepth) {
      throw new Error(`Cannot create nodes deeper than nodes.max_depth (${maxDepth})`);
    }
  }

  const isLeafNode = Number.isFinite(maxDepth) && nextDepth >= maxDepth;

  const sortOrderQuery = isRootInsert
    ? `
      SELECT ISNULL(MAX(sort_order), -1) + 1 AS nextSortOrder
      FROM tree_nodes
      WHERE tree_instance_id = @tree_instance_id AND parent_id IS NULL AND deleted_at IS NULL
    `
    : `
      SELECT ISNULL(MAX(sort_order), -1) + 1 AS nextSortOrder
      FROM tree_nodes
      WHERE tree_instance_id = @tree_instance_id AND parent_id = @parent_id AND deleted_at IS NULL
    `;

  const sortOrderRequest = createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, treeInstanceId);

  if (!isRootInsert) {
    sortOrderRequest.input('parent_id', sql.Int, parentId);
  }

  const sortOrderResult = await sortOrderRequest.query(sortOrderQuery);
  const nextSortOrder = sortOrderResult.recordset[0].nextSortOrder;

  const insertResult = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('parent_id', sql.Int, isRootInsert ? null : parentId)
    .input('text', sql.NVarChar, name)
    .input('is_leaf_node', sql.Bit, isLeafNode ? 1 : 0)
    .input('is_expanded', sql.Bit, isLeafNode ? 0 : 1)
    .input('draggable', sql.Bit, 1)
    .input('sort_order', sql.Int, nextSortOrder)
    .query(`
      DECLARE @createdNodes TABLE (createdNodeId INT);

      INSERT INTO tree_nodes (tree_instance_id, parent_id, text, is_leaf_node, is_expanded, draggable, sort_order)
      OUTPUT INSERTED.id INTO @createdNodes (createdNodeId)
      VALUES (@tree_instance_id, @parent_id, @text, @is_leaf_node, @is_expanded, @draggable, @sort_order)

      SELECT createdNodeId FROM @createdNodes;
    `);
  const createdNodeId = insertResult.recordset[0].createdNodeId;

  if (ensureLeafDetails && isLeafNode) {
    await ensureTreeNodeDetailsRow(createdNodeId, transaction);
  }

  if (!isRootInsert) {
    await createSqlRequest(transaction)
      .input('tree_instance_id', sql.Int, treeInstanceId)
      .input('parent_id', sql.Int, parentId)
      .query(`
        WITH Ancestors AS (
          SELECT id, parent_id, is_leaf_node
          FROM tree_nodes
          WHERE tree_instance_id = @tree_instance_id AND id = @parent_id AND deleted_at IS NULL

          UNION ALL

          SELECT parent.id, parent.parent_id, parent.is_leaf_node
          FROM tree_nodes parent
          INNER JOIN Ancestors child ON child.parent_id = parent.id
          WHERE parent.tree_instance_id = @tree_instance_id
            AND parent.deleted_at IS NULL
        )
        UPDATE tree_nodes
        SET is_expanded = 1
        WHERE tree_instance_id = @tree_instance_id
          AND is_leaf_node = 0
          AND id IN (SELECT id FROM Ancestors);
      `);
  }

  return {
    createdNodeId: String(createdNodeId),
    isLeafNode,
  };
}

export async function CreateTreeNode({ parentId, treeInstanceId, name, ensureLeafDetails = false }) {
  return withSqlConnection(async () => {
    const createdNode = await createTreeNodeRecord({ parentId, treeInstanceId, name, ensureLeafDetails });

    return {
      createdNodeId: createdNode.createdNodeId,
      flatData: await queryTreeData(treeInstanceId),
    };
  });
}

export async function UpdateTreeNodes(treeInstanceId, nodes) {
  return withSqlConnection(async () => {
    for (const node of nodes) {
      await new sql.Request()
        .input('tree_instance_id', sql.Int, treeInstanceId)
        .input('id', sql.Int, node.id)
        .input('parent', sql.Int, node.parent)
        .input('text', sql.NVarChar, node.name)
        .input('sort_order', sql.Int, node.sort_order)
        .query(`
          UPDATE tree_nodes
          SET parent_id = @parent, text = @text, sort_order = @sort_order
          WHERE tree_instance_id = @tree_instance_id AND id = @id
        `);
    }
  });
}

export async function UpdateTreeNodeOpenState(treeInstanceId, nodeId, isExpanded) {
  return withSqlConnection(async () => {
    await new sql.Request()
      .input('tree_instance_id', sql.Int, treeInstanceId)
      .input('id', sql.Int, nodeId)
      .input('is_expanded', sql.Bit, isExpanded ? 1 : 0)
      .query('UPDATE tree_nodes SET is_expanded = @is_expanded WHERE tree_instance_id = @tree_instance_id AND id = @id');
  });
}

export async function UpdateTreeNodeOpenStates(treeInstanceId, nodeIds, isExpanded) {
  const normalizedNodeIds = Array.isArray(nodeIds)
    ? Array.from(new Set(nodeIds.map((nodeId) => Number.parseInt(String(nodeId), 10)).filter(Number.isFinite)))
    : [];

  if (normalizedNodeIds.length === 0) {
    return;
  }

  return withSqlConnection(async () => {
    const request = new sql.Request()
      .input('tree_instance_id', sql.Int, treeInstanceId)
      .input('is_expanded', sql.Bit, isExpanded ? 1 : 0);

    const nodeIdParameters = normalizedNodeIds.map((nodeId, index) => {
      const parameterName = `node_id_${index}`;
      request.input(parameterName, sql.Int, nodeId);
      return `@${parameterName}`;
    });

    await request.query(`
      UPDATE tree_nodes
      SET is_expanded = @is_expanded
      WHERE tree_instance_id = @tree_instance_id
        AND is_leaf_node = 0
        AND id IN (${nodeIdParameters.join(', ')});
    `);
  });
}

export async function assertLeafNode(treeInstanceId, nodeId) {
  const node = await queryTreeNode(treeInstanceId, nodeId);

  if (!node) {
    throw new Error('Node was not found for the selected tree');
  }

  if (!node.isLeafNode) {
    throw new Error('Only leaf nodes can have details or attachments');
  }

  return node;
}

export async function createAttachmentMetadataRecord(treeNodeId, attachment) {
  const insertResult = await new sql.Request()
    .input('tree_node_id', sql.Int, treeNodeId)
    .input('original_file_name', sql.NVarChar(260), attachment.originalFileName)
    .input('content_type', sql.NVarChar(200), attachment.contentType)
    .input('byte_size', sql.BigInt, attachment.byteSize)
    .input('blob_name', sql.NVarChar(1024), attachment.blobName)
    .input('blob_url', sql.NVarChar(2048), attachment.blobUrl)
    .input('updated_by_object_id', sql.NVarChar(100), attachment.updatedByObjectId ?? null)
    .input('updated_by_user_details', sql.NVarChar(320), attachment.updatedByUserDetails ?? null)
    .query(`
      INSERT INTO tree_node_detail_files (
        tree_node_id,
        original_file_name,
        content_type,
        byte_size,
        blob_name,
        blob_url,
        updated_by_object_id,
        updated_by_user_details
      )
      VALUES (
        @tree_node_id,
        @original_file_name,
        @content_type,
        @byte_size,
        @blob_name,
        @blob_url,
        @updated_by_object_id,
        @updated_by_user_details
      );
    `);

  return insertResult.rowsAffected[0] > 0;
}

export async function queryAttachmentRecord(treeInstanceId, attachmentId, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('attachment_id', sql.Int, attachmentId)
    .query(`
      SELECT TOP 1
        CAST(files.id AS VARCHAR(10)) AS id,
        CAST(files.tree_node_id AS VARCHAR(10)) AS treeNodeId,
        files.blob_name AS blobName,
        CAST(CASE WHEN COALESCE(ti.approval_enabled, 0) = 1 THEN COALESCE(files.review_status, '${REVIEW_STATUS_DRAFT}') ELSE '${REVIEW_STATUS_DRAFT}' END AS NVARCHAR(20)) AS reviewStatus
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      WHERE tn.tree_instance_id = @tree_instance_id
        AND tn.deleted_at IS NULL
        AND files.deleted_at IS NULL
        AND files.id = @attachment_id;
    `);

  return result.recordset[0] ?? null;
}

export async function getDescendantAttachmentBlobs(treeInstanceId, nodeId, { includeDeleted = false } = {}) {
  const result = await new sql.Request()
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('id', sql.Int, nodeId)
    .input('include_deleted', sql.Bit, includeDeleted ? 1 : 0)
    .query(`WITH Descendants AS (
        SELECT tn.id
        FROM tree_nodes tn
        WHERE tn.id = @id
          AND tn.tree_instance_id = @tree_instance_id
          AND (@include_deleted = 1 OR tn.deleted_at IS NULL)
        UNION ALL
        SELECT t.id
        FROM tree_nodes t
        INNER JOIN Descendants d ON t.parent_id = d.id
        WHERE t.tree_instance_id = @tree_instance_id
          AND (@include_deleted = 1 OR t.deleted_at IS NULL)
      )
      SELECT
        CAST(files.id AS VARCHAR(10)) AS id,
        CAST(files.tree_node_id AS VARCHAR(10)) AS treeNodeId,
        files.blob_name AS blobName,
        files.blob_url AS blobUrl,
        files.deleted_at AS deletedAt
      FROM Descendants d
      INNER JOIN tree_node_detail_files files ON files.tree_node_id = d.id
      WHERE @include_deleted = 1 OR files.deleted_at IS NULL;
    `);

  return result.recordset;
}

export async function getDescendantSecretMetadata(treeInstanceId, nodeId, { includeDeleted = false } = {}) {
  const result = await createSqlRequest()
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('id', sql.Int, nodeId)
    .input('include_deleted', sql.Bit, includeDeleted ? 1 : 0)
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .query(`WITH Descendants AS (
        SELECT tn.id
        FROM tree_nodes tn
        INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE tn.id = @id
          AND tn.tree_instance_id = @tree_instance_id
          AND ai.app_identifier = @application_identifier
          AND (@include_deleted = 1 OR tn.deleted_at IS NULL)
        UNION ALL
        SELECT t.id
        FROM tree_nodes t
        INNER JOIN Descendants d ON t.parent_id = d.id
        WHERE t.tree_instance_id = @tree_instance_id
          AND (@include_deleted = 1 OR t.deleted_at IS NULL)
      )
      SELECT
        CAST(d.id AS VARCHAR(20)) AS treeNodeId,
        tnd.secret_metadata AS secretMetadata
      FROM Descendants d
      INNER JOIN tree_node_details tnd ON tnd.tree_node_id = d.id
      WHERE CAST(COALESCE(tnd.is_secret, 0) AS BIT) = 1
        AND tnd.secret_metadata IS NOT NULL;
    `);

  return result.recordset
    .map((record) => ({
      treeNodeId: record.treeNodeId,
      secretMetadata: normalizeSecretMetadata(record.secretMetadata),
    }))
    .filter((record) => record.secretMetadata);
}

export async function getNodeGenerationContext(treeInstanceId, nodeId, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('id', sql.Int, nodeId)
    .query(`
      WITH SelectedPath AS (
        SELECT
          id,
          parent_id,
          text,
          is_leaf_node,
          0 AS distance_from_selected
        FROM tree_nodes
        WHERE tree_instance_id = @tree_instance_id AND id = @id AND deleted_at IS NULL

        UNION ALL

        SELECT
          parent.id,
          parent.parent_id,
          parent.text,
          parent.is_leaf_node,
          child.distance_from_selected + 1 AS distance_from_selected
        FROM tree_nodes parent
        INNER JOIN SelectedPath child ON child.parent_id = parent.id
        WHERE parent.tree_instance_id = @tree_instance_id
          AND parent.deleted_at IS NULL
      )
      SELECT
        CAST(id AS VARCHAR(10)) AS id,
        text AS name,
        is_leaf_node AS isLeafNode,
        distance_from_selected AS distanceFromSelected,
        (
          SELECT TOP 1 COALESCE(NULLIF(ti.display_name, ''), CONCAT('Tree ', ti.id))
          FROM tree_instance ti
          WHERE ti.id = @tree_instance_id
            AND ti.deleted_at IS NULL
        ) AS treeName
      FROM SelectedPath
      ORDER BY distance_from_selected DESC;
    `);

  if (result.recordset.length === 0) {
    return null;
  }

  const selectedNode = result.recordset[result.recordset.length - 1];
  const createContext = await getTreeCreateContext(treeInstanceId, nodeId, transaction);
  const parentDepth = Number(createContext?.parentDepth);
  const maxDepth = Number(createContext?.maxDepth);
  const generatedChildIsLeaf = !Boolean(selectedNode.isLeafNode)
    && Number.isFinite(parentDepth)
    && Number.isFinite(maxDepth)
    && parentDepth + 1 >= maxDepth;

  return {
    nodeId: selectedNode.id,
    isLeafNode: Boolean(selectedNode.isLeafNode),
    generatedChildIsLeaf,
    treeName: String(selectedNode.treeName ?? '').trim(),
    breadcrumbTitles: result.recordset.map((row) => String(row.name ?? '').trim()).filter(Boolean),
  };
}

export async function updateTreeNodeText({ treeInstanceId, nodeId, text, transaction = null }) {
  const updateResult = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('id', sql.Int, nodeId)
    .input('text', sql.NVarChar, String(text ?? '').trim())
    .query(`
      UPDATE tree_nodes
      SET text = @text
      WHERE tree_instance_id = @tree_instance_id AND id = @id;
    `);

  return Number(updateResult.rowsAffected?.[0] ?? 0);
}

export async function upsertTreeNodeDetails({
  nodeId,
  notes = '',
  isSecret = false,
  secretMetadata = null,
  updatedBy = null,
  transaction = null,
}) {
  await createSqlRequest(transaction)
    .input('tree_node_id', sql.Int, nodeId)
    .input('notes', sql.NVarChar(sql.MAX), notes)
    .input('is_secret', sql.Bit, isSecret ? 1 : 0)
    .input('secret_metadata', sql.NVarChar(sql.MAX), secretMetadata)
    .input('updated_by_object_id', sql.NVarChar(100), updatedBy?.updatedByObjectId ?? null)
    .input('updated_by_user_details', sql.NVarChar(320), updatedBy?.updatedByUserDetails ?? null)
    .query(`
      MERGE tree_node_details AS target
      USING (SELECT @tree_node_id AS tree_node_id) AS source
        ON target.tree_node_id = source.tree_node_id
      WHEN MATCHED THEN
        UPDATE SET
          notes = @notes,
          is_secret = @is_secret,
          secret_metadata = @secret_metadata,
          updated_by_object_id = @updated_by_object_id,
          updated_by_user_details = @updated_by_user_details,
          updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (tree_node_id, notes, is_secret, secret_metadata, created_at, updated_at, updated_by_object_id, updated_by_user_details)
        VALUES (@tree_node_id, @notes, @is_secret, @secret_metadata, SYSUTCDATETIME(), SYSUTCDATETIME(), @updated_by_object_id, @updated_by_user_details);
    `);
}

export async function applyTreeNodeReviewStatus({
  treeInstanceId,
  nodeId,
  reviewStatus,
  submittedByObjectId = null,
  submittedByUserDetails = null,
  reviewedByObjectId = null,
  reviewedByUserDetails = null,
  rejectionComment = null,
  transaction = null,
}) {
  await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('id', sql.Int, nodeId)
    .input('review_status', sql.NVarChar(20), reviewStatus)
    .input('submitted_by_object_id', sql.NVarChar(100), submittedByObjectId)
    .input('submitted_by_user_details', sql.NVarChar(320), submittedByUserDetails)
    .input('reviewed_by_object_id', sql.NVarChar(100), reviewedByObjectId)
    .input('reviewed_by_user_details', sql.NVarChar(320), reviewedByUserDetails)
    .input('rejection_comment', sql.NVarChar(2000), rejectionComment)
    .query(`
      WITH Descendants AS (
        SELECT id
        FROM tree_nodes
        WHERE id = @id
          AND tree_instance_id = @tree_instance_id
          AND deleted_at IS NULL

        UNION ALL

        SELECT child.id
        FROM tree_nodes child
        INNER JOIN Descendants parent_descendant ON child.parent_id = parent_descendant.id
        WHERE child.tree_instance_id = @tree_instance_id
          AND child.deleted_at IS NULL
      )
      UPDATE tree_nodes
      SET review_status = @review_status,
          submitted_at = CASE
            WHEN @review_status = '${REVIEW_STATUS_SUBMITTED}' THEN SYSUTCDATETIME()
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            ELSE submitted_at
          END,
          submitted_by_object_id = CASE
            WHEN @review_status = '${REVIEW_STATUS_SUBMITTED}' THEN @submitted_by_object_id
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            ELSE submitted_by_object_id
          END,
          submitted_by_user_details = CASE
            WHEN @review_status = '${REVIEW_STATUS_SUBMITTED}' THEN @submitted_by_user_details
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            ELSE submitted_by_user_details
          END,
          reviewed_at = CASE
            WHEN @review_status = '${REVIEW_STATUS_SUBMITTED}' THEN NULL
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            ELSE SYSUTCDATETIME()
          END,
          reviewed_by_object_id = CASE
            WHEN @review_status = '${REVIEW_STATUS_SUBMITTED}' THEN NULL
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            ELSE @reviewed_by_object_id
          END,
          reviewed_by_user_details = CASE
            WHEN @review_status = '${REVIEW_STATUS_SUBMITTED}' THEN NULL
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            ELSE @reviewed_by_user_details
          END,
          rejection_comment = CASE
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            WHEN @review_status = '${REVIEW_STATUS_APPROVED}' THEN NULL
            WHEN @review_status = '${REVIEW_STATUS_REJECTED}' THEN COALESCE(NULLIF(LTRIM(RTRIM(tree_nodes.rejection_comment)), ''), @rejection_comment)
            ELSE tree_nodes.rejection_comment
          END,
          updated_at = SYSUTCDATETIME()
      FROM tree_nodes
      INNER JOIN Descendants ON Descendants.id = tree_nodes.id
      WHERE tree_nodes.tree_instance_id = @tree_instance_id
      OPTION (MAXRECURSION 32767);
    `);
}

export async function applyAttachmentReviewStatus({
  attachmentId,
  reviewStatus,
  submittedByObjectId = null,
  submittedByUserDetails = null,
  reviewedByObjectId = null,
  reviewedByUserDetails = null,
  rejectionComment = null,
  transaction = null,
}) {
  await createSqlRequest(transaction)
    .input('attachment_id', sql.Int, attachmentId)
    .input('review_status', sql.NVarChar(20), reviewStatus)
    .input('submitted_by_object_id', sql.NVarChar(100), submittedByObjectId)
    .input('submitted_by_user_details', sql.NVarChar(320), submittedByUserDetails)
    .input('reviewed_by_object_id', sql.NVarChar(100), reviewedByObjectId)
    .input('reviewed_by_user_details', sql.NVarChar(320), reviewedByUserDetails)
    .input('rejection_comment', sql.NVarChar(2000), rejectionComment)
    .query(`
      UPDATE tree_node_detail_files
      SET review_status = @review_status,
          submitted_at = CASE
            WHEN @review_status = '${REVIEW_STATUS_SUBMITTED}' THEN SYSUTCDATETIME()
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            ELSE submitted_at
          END,
          submitted_by_object_id = CASE
            WHEN @review_status = '${REVIEW_STATUS_SUBMITTED}' THEN @submitted_by_object_id
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            ELSE submitted_by_object_id
          END,
          submitted_by_user_details = CASE
            WHEN @review_status = '${REVIEW_STATUS_SUBMITTED}' THEN @submitted_by_user_details
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            ELSE submitted_by_user_details
          END,
          reviewed_at = CASE
            WHEN @review_status = '${REVIEW_STATUS_SUBMITTED}' THEN NULL
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            ELSE SYSUTCDATETIME()
          END,
          reviewed_by_object_id = CASE
            WHEN @review_status = '${REVIEW_STATUS_SUBMITTED}' THEN NULL
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            ELSE @reviewed_by_object_id
          END,
          reviewed_by_user_details = CASE
            WHEN @review_status = '${REVIEW_STATUS_SUBMITTED}' THEN NULL
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            ELSE @reviewed_by_user_details
          END,
          rejection_comment = CASE
            WHEN @review_status = '${REVIEW_STATUS_DRAFT}' THEN NULL
            WHEN @review_status = '${REVIEW_STATUS_APPROVED}' THEN NULL
            WHEN @review_status = '${REVIEW_STATUS_REJECTED}' THEN COALESCE(NULLIF(LTRIM(RTRIM(rejection_comment)), ''), @rejection_comment)
            ELSE rejection_comment
          END,
          updated_at = SYSUTCDATETIME()
      WHERE id = @attachment_id
        AND deleted_at IS NULL;
    `);
}

export async function queryAttachmentDeleteRecord(treeInstanceId, attachmentId, transaction = null) {
  const attachmentResult = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('attachment_id', sql.Int, attachmentId)
    .query(`
      SELECT TOP 1
        CAST(files.tree_node_id AS VARCHAR(10)) AS treeNodeId,
        files.blob_name AS blobName
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      WHERE tn.tree_instance_id = @tree_instance_id AND tn.deleted_at IS NULL AND files.deleted_at IS NULL AND files.id = @attachment_id;
    `);

  return attachmentResult.recordset[0] ?? null;
}

export async function softDeleteAttachmentMetadataRecord({ attachmentId, updatedBy = null, transaction = null }) {
  const deletedAt = new Date();
  const deleteResult = await createSqlRequest(transaction)
    .input('attachment_id', sql.Int, attachmentId)
    .input('deleted_at', sql.DateTime2, deletedAt)
    .input('updated_by_object_id', sql.NVarChar(100), updatedBy?.updatedByObjectId ?? null)
    .input('updated_by_user_details', sql.NVarChar(320), updatedBy?.updatedByUserDetails ?? null)
    .query(`
      UPDATE tree_node_detail_files
      SET deleted_at = @deleted_at,
          updated_by_object_id = @updated_by_object_id,
          updated_by_user_details = @updated_by_user_details,
          updated_at = @deleted_at
      WHERE id = @attachment_id
        AND deleted_at IS NULL;
    `);

  return Number(deleteResult.rowsAffected?.[0] ?? 0);
}

export async function queryTreeNodesByReviewStatus(applicationIdentifier, reviewStatus, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('review_status', sql.NVarChar(20), reviewStatus)
    .query(`
      WITH NodePaths AS (
        SELECT
          tn.id,
          tn.tree_instance_id,
          tn.parent_id,
          tn.text,
          CAST(tn.text AS NVARCHAR(MAX)) AS breadcrumb
        FROM tree_nodes tn
        WHERE tn.parent_id IS NULL
          AND tn.deleted_at IS NULL

        UNION ALL

        SELECT
          child.id,
          child.tree_instance_id,
          child.parent_id,
          child.text,
          CAST(parent_path.breadcrumb + N' > ' + child.text AS NVARCHAR(MAX)) AS breadcrumb
        FROM tree_nodes child
        INNER JOIN NodePaths parent_path ON child.parent_id = parent_path.id
        WHERE child.deleted_at IS NULL
      )
      SELECT
        CAST(tn.id AS VARCHAR(10)) AS id,
        CAST(tn.tree_instance_id AS VARCHAR(10)) AS treeId,
        COALESCE(NULLIF(ti.display_name, ''), CONCAT('Tree ', ti.id)) AS treeName,
        CAST(ti.is_private AS bit) AS isPrivate,
        tn.text AS name,
        CAST(tn.is_leaf_node AS bit) AS isLeafNode,
        CAST(np.breadcrumb AS NVARCHAR(MAX)) AS breadcrumb,
        CAST(tn.review_status AS NVARCHAR(20)) AS reviewStatus,
        tn.submitted_at AS submittedAt,
        tn.submitted_by_user_details AS submittedByUserDetails,
        tn.reviewed_at AS reviewedAt,
        tn.reviewed_by_user_details AS reviewedByUserDetails,
        tn.rejection_comment AS rejectionComment
      FROM tree_nodes tn
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      INNER JOIN NodePaths np ON np.id = tn.id
      WHERE ai.app_identifier = @application_identifier
        AND ti.deleted_at IS NULL
        AND tn.deleted_at IS NULL
        AND COALESCE(ti.approval_enabled, 0) = 1
        AND tn.review_status = @review_status
      ORDER BY ti.id DESC, np.breadcrumb ASC;
    `);

  return result.recordset;
}

export async function queryTreeAttachmentsByReviewStatus(applicationIdentifier, reviewStatus, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('review_status', sql.NVarChar(20), reviewStatus)
    .query(`
      WITH NodePaths AS (
        SELECT
          tn.id,
          tn.tree_instance_id,
          tn.parent_id,
          tn.text,
          CAST(tn.text AS NVARCHAR(MAX)) AS breadcrumb
        FROM tree_nodes tn
        WHERE tn.parent_id IS NULL
          AND tn.deleted_at IS NULL

        UNION ALL

        SELECT
          child.id,
          child.tree_instance_id,
          child.parent_id,
          child.text,
          CAST(parent_path.breadcrumb + N' > ' + child.text AS NVARCHAR(MAX)) AS breadcrumb
        FROM tree_nodes child
        INNER JOIN NodePaths parent_path ON child.parent_id = parent_path.id
        WHERE child.deleted_at IS NULL
      )
      SELECT
        CAST(files.id AS VARCHAR(10)) AS id,
        CAST(tn.id AS VARCHAR(10)) AS nodeId,
        CAST(tn.tree_instance_id AS VARCHAR(10)) AS treeId,
        COALESCE(NULLIF(ti.display_name, ''), CONCAT('Tree ', ti.id)) AS treeName,
        CAST(ti.is_private AS bit) AS isPrivate,
        CAST(np.breadcrumb AS NVARCHAR(MAX)) AS nodeBreadcrumb,
        files.original_file_name AS fileName,
        CAST(files.review_status AS NVARCHAR(20)) AS reviewStatus,
        files.submitted_at AS submittedAt,
        files.submitted_by_user_details AS submittedByUserDetails,
        files.reviewed_at AS reviewedAt,
        files.reviewed_by_user_details AS reviewedByUserDetails,
        files.rejection_comment AS rejectionComment
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      INNER JOIN NodePaths np ON np.id = tn.id
      WHERE ai.app_identifier = @application_identifier
        AND ti.deleted_at IS NULL
        AND tn.deleted_at IS NULL
        AND files.deleted_at IS NULL
        AND COALESCE(ti.approval_enabled, 0) = 1
        AND files.review_status = @review_status
      ORDER BY ti.id DESC, np.breadcrumb ASC, files.created_at DESC, files.id DESC;
    `);

  return result.recordset;
}

export async function queryIndividuallyDeletedAttachments(applicationIdentifier, transaction = null) {
  const result = await createSqlRequest(transaction)
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

export async function queryDeletedTreeAttachmentBlobs(applicationIdentifier, treeId, deletedAt, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('tree_deleted_at', sql.DateTime2, deletedAt)
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

  return result.recordset;
}

export async function queryDeletedTreeSecretMetadata(applicationIdentifier, treeId, deletedAt, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('tree_deleted_at', sql.DateTime2, deletedAt)
    .query(`
      SELECT CAST(tn.id AS VARCHAR(20)) AS treeNodeId, tnd.secret_metadata AS secretMetadata
      FROM tree_node_details tnd
      INNER JOIN tree_nodes tn ON tn.id = tnd.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ai.app_identifier = @application_identifier
        AND ti.id = @tree_instance_id
        AND ti.deleted_at = @tree_deleted_at
        AND CAST(COALESCE(tnd.is_secret, 0) AS BIT) = 1
        AND tnd.secret_metadata IS NOT NULL;
    `);

  return result.recordset;
}

export async function queryDeletedNodeAttachmentBlobs(applicationIdentifier, treeId, nodeId, deletedAt, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('node_id', sql.Int, Number(nodeId))
    .input('node_deleted_at', sql.DateTime2, deletedAt)
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

  return result.recordset;
}

export async function queryDeletedNodeSecretMetadata(applicationIdentifier, treeId, nodeId, deletedAt, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('application_identifier', sql.NVarChar, applicationIdentifier)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('node_id', sql.Int, Number(nodeId))
    .input('node_deleted_at', sql.DateTime2, deletedAt)
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
      SELECT CAST(Descendants.id AS VARCHAR(20)) AS treeNodeId, tnd.secret_metadata AS secretMetadata
      FROM Descendants
      INNER JOIN tree_node_details tnd ON tnd.tree_node_id = Descendants.id
      WHERE CAST(COALESCE(tnd.is_secret, 0) AS BIT) = 1
        AND tnd.secret_metadata IS NOT NULL;
    `);

  return result.recordset;
}

export async function queryDeletedAttachmentForUndelete(applicationIdentifier, treeId, attachmentId, transaction = null) {
  const result = await createSqlRequest(transaction)
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

  return result.recordset[0] ?? null;
}

export async function queryDeletedTreeForUndelete(applicationIdentifier, treeId, transaction = null) {
  const result = await createSqlRequest(transaction)
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

  return result.recordset[0] ?? null;
}

export async function queryDeletedNodeForUndelete(applicationIdentifier, treeId, nodeId, transaction = null) {
  const result = await createSqlRequest(transaction)
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

  return result.recordset[0] ?? null;
}