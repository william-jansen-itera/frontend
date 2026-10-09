import {
  downloadNodeAttachmentBlob,
} from '@/server/utils/blobStorage';
import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';
import {
  deleteTreePath,
  ensureTreePath,
  findTreePathNode,
  readSingleTreeTextAttachmentByFileName,
  replaceTreeLeafAttachment,
} from '@/server/utils/tree/treePathRepository';

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

async function resolveInvestmentTreePathNodes({ treeId, pathSegments, transaction = null }) {
  const normalizedPathSegments = normalizePathSegments(pathSegments);
  const resolvedNodes = [];
  let currentParentId = null;

  for (const pathSegment of normalizedPathSegments) {
    const currentNode = await findChildNode(treeId, currentParentId, pathSegment, transaction);

    if (!currentNode) {
      return null;
    }

    resolvedNodes.push(currentNode);
    currentParentId = Number(currentNode.id);
  }

  return resolvedNodes;
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

export async function assertConfiguredInvestmentTree(treeId, options = {}) {
  const {
    allowPrivate = false,
    allowDescription = true,
    allowPublishedDescription = true,
  } = options;

  return withSqlConnection(async () => {
    const configuredTree = await queryConfiguredTree(treeId);

    if (!configuredTree) {
      throw createStatusError(`Configured investment tree ${treeId} was not found in the current application scope.`, 500);
    }

    if (!allowPrivate && configuredTree.isPrivate) {
      throw createStatusError(`Configured investment tree ${treeId} must be public.`, 500);
    }

    if (!allowDescription && String(configuredTree.description ?? '').trim()) {
      throw createStatusError(`Configured investment tree ${treeId} must not have a description.`, 500);
    }

    if (!allowPublishedDescription && configuredTree.isDescriptionPublished) {
      throw createStatusError(`Configured investment tree ${treeId} must not be published to tree grounding.`, 500);
    }

    return configuredTree;
  });
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

export async function findInvestmentTreePathNode({ treeId, pathSegments, transaction = null }) {
  return findTreePathNode({ treeId, pathSegments, transaction });
}

export async function getInvestmentRepositoryCitation({ treeId, pathSegments, fileName, treeOptions = null }) {
  return withSqlConnection(async () => {
    const configuredTree = await queryConfiguredTree(treeId);

    if (!configuredTree) {
      return null;
    }

    const resolvedNodes = await resolveInvestmentTreePathNodes({ treeId, pathSegments });

    if (!Array.isArray(resolvedNodes) || resolvedNodes.length === 0) {
      return null;
    }

    const leafNode = resolvedNodes[resolvedNodes.length - 1];
    const attachments = await listActiveNodeAttachments({ treeId, nodeId: leafNode.id });
    const normalizedFileName = String(fileName ?? '').trim().toLowerCase();
    const matchingAttachment = attachments.find((attachment) => String(attachment.fileName ?? '').trim().toLowerCase() === normalizedFileName);

    if (!matchingAttachment) {
      return null;
    }

    return {
      treeId,
      nodeId: leafNode.id,
      title: leafNode.text,
      breadcrumb: resolvedNodes.map((node) => String(node.text ?? '').trim()).filter(Boolean).join(' > '),
      nodeIdPath: resolvedNodes.map((node) => String(node.id ?? '').trim()).filter(Boolean).join('/'),
      visibility: configuredTree.isPrivate ? 'private' : 'public',
      treeDisplayName: configuredTree.displayName ?? null,
      matchSummary: matchingAttachment.fileName ?? null,
      attachmentFileNames: matchingAttachment.fileName ? [matchingAttachment.fileName] : [],
    };
  });
}

export async function ensureInvestmentTreePath({ treeId, pathSegments, treeOptions = null }) {
  return ensureTreePath({ treeId, pathSegments, treeOptions });
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

export async function listInvestmentLeafAttachments({ treeId, pathSegments, treeOptions = null }) {
  return withSqlConnection(async () => {
    await assertConfiguredInvestmentTree(treeId, treeOptions ?? undefined);
    const pathNode = await findInvestmentTreePathNode({ treeId, pathSegments });

    if (!pathNode) {
      return [];
    }

    return listActiveNodeAttachments({ treeId, nodeId: pathNode.id });
  });
}

export async function readSingleInvestmentTextAttachmentByExtension({ treeId, pathSegments, extension, requiredLabel, treeOptions = null }) {
  return withSqlConnection(async () => {
    await assertConfiguredInvestmentTree(treeId, treeOptions ?? undefined);
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

export async function readSingleInvestmentTextAttachmentByFileName({ treeId, pathSegments, fileName, treeOptions = null }) {
  return readSingleTreeTextAttachmentByFileName({ treeId, pathSegments, fileName, treeOptions });
}

export async function deleteInvestmentTreePath({ treeId, pathSegments, updatedBy = null, treeOptions = null }) {
  return deleteTreePath({ treeId, pathSegments, updatedBy, treeOptions });
}

export async function replaceInvestmentLeafAttachment({
  treeId,
  pathSegments,
  fileName,
  contentType,
  content,
  updatedBy = null,
  treeOptions = null,
}) {
  return replaceTreeLeafAttachment({
    treeId,
    pathSegments,
    fileName,
    contentType,
    content,
    updatedBy,
    treeOptions,
  });
}