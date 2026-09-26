import {
  deleteNodeAttachmentBlobIfExists,
  downloadNodeAttachmentBlob,
  uploadNodeAttachment,
} from '@/server/utils/blobStorage';
import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';

function createSqlRequest(transaction = null) {
  return transaction ? new sql.Request(transaction) : new sql.Request();
}

function createStatusError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizePathSegments(pathSegments) {
  if (!Array.isArray(pathSegments) || pathSegments.length === 0) {
    throw new Error('A non-empty path is required.');
  }

  return pathSegments.map((segment) => {
    const normalizedSegment = String(segment ?? '').trim();

    if (!normalizedSegment) {
      throw new Error('Tree path segments must be non-empty strings.');
    }

    return normalizedSegment;
  });
}

async function queryConfiguredTree(treeId, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .query(`
      SELECT TOP 1
        ti.id,
        CAST(COALESCE(ti.is_private, 0) AS BIT) AS isPrivate,
        CAST(COALESCE(ti.description, '') AS NVARCHAR(MAX)) AS description,
        CAST(COALESCE(ti.description_published_to_agent, 0) AS BIT) AS isDescriptionPublished,
        COALESCE(NULLIF(ti.display_name, ''), CONCAT('Tree ', ti.id)) AS displayName
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ti.id = @tree_instance_id
        AND ti.deleted_at IS NULL
        AND ai.app_identifier = @application_identifier;
    `);

  return result.recordset[0] ?? null;
}

export async function assertConfiguredInvestmentTree(treeId) {
  return withSqlConnection(async () => {
    const configuredTree = await queryConfiguredTree(treeId);

    if (!configuredTree) {
      throw createStatusError(`Configured investment tree ${treeId} was not found in the current application scope.`, 500);
    }

    if (configuredTree.isPrivate) {
      throw createStatusError(`Configured investment tree ${treeId} must be public.`, 500);
    }

    if (String(configuredTree.description ?? '').trim()) {
      throw createStatusError(`Configured investment tree ${treeId} must not have a description.`, 500);
    }

    if (configuredTree.isDescriptionPublished) {
      throw createStatusError(`Configured investment tree ${treeId} must not be published to tree grounding.`, 500);
    }

    return configuredTree;
  });
}

async function getTreeCreateContext(treeId, parentId, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('parent_id', sql.Int, Number(parentId))
    .query(`WITH RecursiveTree AS (
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
          child.id,
          child.parent_id,
          parent.depth + 1 AS depth
        FROM tree_nodes child
        INNER JOIN RecursiveTree parent ON child.parent_id = parent.id
        WHERE child.tree_instance_id = @tree_instance_id
          AND child.deleted_at IS NULL
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
        AND parent_node.id = @parent_id;
    `);

  return result.recordset[0] ?? null;
}

async function findChildNode(treeId, parentId, text, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('parent_id', parentId === null ? sql.Int : sql.Int, parentId === null ? null : Number(parentId))
    .input('text', sql.NVarChar(255), text)
    .query(`
      SELECT TOP 1
        CAST(id AS VARCHAR(10)) AS id,
        text,
        is_leaf_node AS isLeafNode
      FROM tree_nodes
      WHERE tree_instance_id = @tree_instance_id
        AND deleted_at IS NULL
        AND ((@parent_id IS NULL AND parent_id IS NULL) OR parent_id = @parent_id)
        AND text = @text
      ORDER BY sort_order, id;
    `);

  return result.recordset[0] ?? null;
}

async function getNextSortOrder(treeId, parentId, transaction = null) {
  const request = createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, Number(treeId));

  const query = parentId === null
    ? `
      SELECT ISNULL(MAX(sort_order), -1) + 1 AS nextSortOrder
      FROM tree_nodes
      WHERE tree_instance_id = @tree_instance_id
        AND parent_id IS NULL
        AND deleted_at IS NULL;
    `
    : `
      SELECT ISNULL(MAX(sort_order), -1) + 1 AS nextSortOrder
      FROM tree_nodes
      WHERE tree_instance_id = @tree_instance_id
        AND parent_id = @parent_id
        AND deleted_at IS NULL;
    `;

  if (parentId !== null) {
    request.input('parent_id', sql.Int, Number(parentId));
  }

  const result = await request.query(query);

  return Number(result.recordset[0]?.nextSortOrder ?? 0);
}

async function ensureTreeNodeDetailsRow(treeNodeId, transaction = null) {
  await createSqlRequest(transaction)
    .input('tree_node_id', sql.Int, Number(treeNodeId))
    .query(`
      MERGE tree_node_details AS target
      USING (SELECT @tree_node_id AS tree_node_id) AS source
        ON target.tree_node_id = source.tree_node_id
      WHEN NOT MATCHED THEN
        INSERT (tree_node_id, notes, created_at, updated_at)
        VALUES (@tree_node_id, '', SYSUTCDATETIME(), SYSUTCDATETIME());
    `);
}

async function createNodeRecord({ treeId, parentId, text, isLeafNode, transaction = null }) {
  const createContext = parentId === null ? null : await getTreeCreateContext(treeId, parentId, transaction);

  if (parentId !== null && !createContext) {
    throw new Error('Parent node was not found for the selected investment tree path.');
  }

  if (createContext?.isLeafNode) {
    throw new Error('Cannot add a child beneath a leaf attachment node in the investment tree.');
  }

  const parentDepth = parentId === null ? -1 : Number(createContext?.parentDepth);
  const nextDepth = parentDepth + 1;
  const maxDepth = Number(createContext?.maxDepth);

  if (Number.isFinite(maxDepth) && nextDepth > maxDepth) {
    throw new Error(`Cannot create investment nodes deeper than nodes.max_depth (${maxDepth}).`);
  }

  const sortOrder = await getNextSortOrder(treeId, parentId, transaction);
  const insertResult = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('parent_id', sql.Int, parentId === null ? null : Number(parentId))
    .input('text', sql.NVarChar(255), text)
    .input('is_leaf_node', sql.Bit, isLeafNode ? 1 : 0)
    .input('is_expanded', sql.Bit, isLeafNode ? 0 : 1)
    .input('draggable', sql.Bit, 1)
    .input('sort_order', sql.Int, sortOrder)
    .query(`
      DECLARE @createdNodes TABLE (createdNodeId INT);

      INSERT INTO tree_nodes (tree_instance_id, parent_id, text, is_leaf_node, is_expanded, draggable, sort_order)
      OUTPUT INSERTED.id INTO @createdNodes (createdNodeId)
      VALUES (@tree_instance_id, @parent_id, @text, @is_leaf_node, @is_expanded, @draggable, @sort_order);

      SELECT createdNodeId FROM @createdNodes;
    `);

  const createdNodeId = Number(insertResult.recordset[0]?.createdNodeId);

  if (!createdNodeId) {
    throw new Error('Failed to create an investment tree node.');
  }

  if (isLeafNode) {
    await ensureTreeNodeDetailsRow(createdNodeId, transaction);
  }

  if (parentId !== null) {
    await createSqlRequest(transaction)
      .input('tree_instance_id', sql.Int, Number(treeId))
      .input('parent_id', sql.Int, Number(parentId))
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
    id: String(createdNodeId),
    text,
    isLeafNode: Boolean(isLeafNode),
  };
}

export async function findInvestmentTreePathNode({ treeId, pathSegments, transaction = null }) {
  const normalizedPathSegments = normalizePathSegments(pathSegments);
  let currentParentId = null;
  let currentNode = null;

  for (const pathSegment of normalizedPathSegments) {
    currentNode = await findChildNode(treeId, currentParentId, pathSegment, transaction);

    if (!currentNode) {
      return null;
    }

    currentParentId = Number(currentNode.id);
  }

  return currentNode;
}

export async function ensureInvestmentTreePath({ treeId, pathSegments }) {
  return withSqlConnection(async () => {
    await assertConfiguredInvestmentTree(treeId);
    const normalizedPathSegments = normalizePathSegments(pathSegments);
    const transaction = new sql.Transaction();

    try {
      await transaction.begin();

      let parentId = null;
      let currentNode = null;

      for (const [index, pathSegment] of normalizedPathSegments.entries()) {
        const isLastSegment = index === normalizedPathSegments.length - 1;
        const existingNode = await findChildNode(treeId, parentId, pathSegment, transaction);

        if (existingNode) {
          if (!isLastSegment && existingNode.isLeafNode) {
            throw new Error(`Cannot descend through leaf node ${pathSegment} while ensuring investment tree path.`);
          }

          if (isLastSegment && !existingNode.isLeafNode) {
            throw new Error(`Configured attachment anchor ${pathSegment} is not a leaf node.`);
          }

          currentNode = existingNode;
          parentId = Number(existingNode.id);
          continue;
        }

        currentNode = await createNodeRecord({
          treeId,
          parentId,
          text: pathSegment,
          isLeafNode: isLastSegment,
          transaction,
        });
        parentId = Number(currentNode.id);
      }

      await transaction.commit();

      return currentNode;
    } catch (error) {
      if (transaction._aborted !== true) {
        await transaction.rollback();
      }

      throw error;
    }
  });
}

async function listActiveNodeAttachments({ treeId, nodeId, transaction = null }) {
  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('node_id', sql.Int, Number(nodeId))
    .query(`
      SELECT
        CAST(files.id AS VARCHAR(10)) AS id,
        files.original_file_name AS fileName,
        files.content_type AS contentType,
        files.byte_size AS byteSize,
        files.blob_name AS blobName,
        files.blob_url AS blobUrl
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      WHERE tn.tree_instance_id = @tree_instance_id
        AND tn.id = @node_id
        AND tn.deleted_at IS NULL
        AND files.deleted_at IS NULL
      ORDER BY files.updated_at DESC, files.id DESC;
    `);

  return result.recordset;
}

export async function listInvestmentLeafAttachments({ treeId, pathSegments }) {
  return withSqlConnection(async () => {
    await assertConfiguredInvestmentTree(treeId);
    const pathNode = await findInvestmentTreePathNode({ treeId, pathSegments });

    if (!pathNode) {
      return [];
    }

    return listActiveNodeAttachments({ treeId, nodeId: pathNode.id });
  });
}

export async function readSingleInvestmentTextAttachmentByExtension({ treeId, pathSegments, extension, requiredLabel }) {
  return withSqlConnection(async () => {
    await assertConfiguredInvestmentTree(treeId);
    const pathNode = await findInvestmentTreePathNode({ treeId, pathSegments });

    if (!pathNode) {
      throw new Error(`${requiredLabel} path was not found in the configured investment tree.`);
    }

    const attachments = await listActiveNodeAttachments({ treeId, nodeId: pathNode.id });
    const normalizedExtension = String(extension ?? '').trim().toLowerCase();
    const matches = attachments.filter((attachment) => String(attachment.fileName ?? '').trim().toLowerCase().endsWith(normalizedExtension));

    if (matches.length === 0) {
      throw new Error(`${requiredLabel} attachment was not found in the configured investment tree.`);
    }

    if (matches.length > 1) {
      throw new Error(`${requiredLabel} path contains multiple ${normalizedExtension} attachments; expected exactly one rolling file.`);
    }

    const downloadedAttachment = await downloadNodeAttachmentBlob(matches[0].blobName);

    return {
      text: downloadedAttachment.content.toString('utf8'),
      attachment: matches[0],
      nodeId: pathNode.id,
    };
  });
}

export async function readSingleInvestmentTextAttachmentByFileName({ treeId, pathSegments, fileName }) {
  return withSqlConnection(async () => {
    await assertConfiguredInvestmentTree(treeId);
    const pathNode = await findInvestmentTreePathNode({ treeId, pathSegments });

    if (!pathNode) {
      return null;
    }

    const attachments = await listActiveNodeAttachments({ treeId, nodeId: pathNode.id });
    const normalizedFileName = String(fileName ?? '').trim().toLowerCase();
    const matches = attachments.filter((attachment) => String(attachment.fileName ?? '').trim().toLowerCase() === normalizedFileName);

    if (matches.length === 0) {
      return null;
    }

    if (matches.length > 1) {
      throw new Error(`${fileName} path contains multiple matching attachments; expected exactly one rolling file.`);
    }

    const downloadedAttachment = await downloadNodeAttachmentBlob(matches[0].blobName);

    return {
      text: downloadedAttachment.content.toString('utf8'),
      attachment: matches[0],
      nodeId: pathNode.id,
    };
  });
}

function buildVirtualFile(fileName, contentType, contentBuffer) {
  const normalizedBuffer = Buffer.isBuffer(contentBuffer) ? contentBuffer : Buffer.from(contentBuffer);

  return {
    name: fileName,
    type: contentType,
    size: normalizedBuffer.byteLength,
    async arrayBuffer() {
      return normalizedBuffer.buffer.slice(
        normalizedBuffer.byteOffset,
        normalizedBuffer.byteOffset + normalizedBuffer.byteLength,
      );
    },
  };
}

async function createAttachmentMetadataRecord(transaction, treeNodeId, attachment) {
  await createSqlRequest(transaction)
    .input('tree_node_id', sql.Int, Number(treeNodeId))
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
}

async function markAttachmentsDeleted(transaction, attachmentIds, updatedBy = null) {
  if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) {
    return;
  }

  const deletedAt = new Date();
  const request = createSqlRequest(transaction)
    .input('deleted_at', sql.DateTime2, deletedAt)
    .input('updated_by_object_id', sql.NVarChar(100), updatedBy?.updatedByObjectId ?? null)
    .input('updated_by_user_details', sql.NVarChar(320), updatedBy?.updatedByUserDetails ?? null);

  const idPlaceholders = attachmentIds.map((attachmentId, index) => {
    const parameterName = `attachment_id_${index}`;
    request.input(parameterName, sql.Int, Number(attachmentId));
    return `@${parameterName}`;
  });

  await request.query(`
    UPDATE tree_node_detail_files
    SET deleted_at = @deleted_at,
        updated_by_object_id = @updated_by_object_id,
        updated_by_user_details = @updated_by_user_details,
        updated_at = @deleted_at
    WHERE id IN (${idPlaceholders.join(', ')})
      AND deleted_at IS NULL;
  `);
}

export async function replaceInvestmentLeafAttachment({
  treeId,
  pathSegments,
  fileName,
  contentType,
  content,
  updatedBy = null,
}) {
  return withSqlConnection(async () => {
    await assertConfiguredInvestmentTree(treeId);
    const leafNode = await ensureInvestmentTreePath({ treeId, pathSegments });
    const attachments = await listActiveNodeAttachments({ treeId, nodeId: leafNode.id });
    const replacedAttachments = attachments.filter((attachment) => String(attachment.fileName ?? '').trim().toLowerCase() === String(fileName ?? '').trim().toLowerCase());
    const replacementFile = buildVirtualFile(fileName, contentType, Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
    const uploadedAttachment = await uploadNodeAttachment({
      treeId: String(treeId),
      nodeId: String(leafNode.id),
      file: replacementFile,
      updatedBy,
    });
    const transaction = new sql.Transaction();

    try {
      await transaction.begin();
      await createAttachmentMetadataRecord(transaction, leafNode.id, {
        originalFileName: fileName,
        contentType: uploadedAttachment.contentType,
        byteSize: uploadedAttachment.byteSize,
        blobName: uploadedAttachment.blobName,
        blobUrl: uploadedAttachment.blobUrl,
        updatedByObjectId: updatedBy?.updatedByObjectId ?? null,
        updatedByUserDetails: updatedBy?.updatedByUserDetails ?? null,
      });
      await markAttachmentsDeleted(transaction, replacedAttachments.map((attachment) => attachment.id), updatedBy);
      await transaction.commit();
    } catch (error) {
      if (transaction._aborted !== true) {
        await transaction.rollback();
      }

      await deleteNodeAttachmentBlobIfExists(uploadedAttachment.blobName);
      throw error;
    }

    await Promise.allSettled(replacedAttachments.map((attachment) => deleteNodeAttachmentBlobIfExists(attachment.blobName)));

    return {
      nodeId: String(leafNode.id),
      fileName,
      blobName: uploadedAttachment.blobName,
      blobUrl: uploadedAttachment.blobUrl,
    };
  });
}