import { randomUUID } from 'crypto';
import { deleteNodeAttachmentBlobIfExists } from '@/server/utils/blobStorage';
import { normalizeClientPrincipal } from '@/shared/clientPrincipal';
import { sql, withSqlConnection, getRequiredApplicationIdentifier } from '@/server/utils/sql';

const MAX_NON_LEAF_TITLES = 64;
const MAX_LEAF_TITLE_EXEMPLARS = 48;
const MAX_BREADCRUMB_EXEMPLARS = 48;
const MAX_ATTACHMENT_FILE_NAME_EXEMPLARS = 32;
const DEFAULT_TREE_MAX_DEPTH = '3';
const TREE_VISIBILITY_PUBLIC = 'public';
const TREE_VISIBILITY_PRIVATE = 'private';
const TREE_VISIBILITY_BOTH = 'both';

function normalizeTreeName(name) {
  return String(name ?? '').trim();
}

function normalizeTreeDescription(description) {
  return String(description ?? '').trim();
}

function buildTreeKey(name) {
  const normalizedBase = normalizeTreeName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  const keyBase = normalizedBase || 'tree';

  return `${keyBase}-${randomUUID().slice(0, 8)}`;
}

async function getScopedApplicationInstanceId() {
  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .query(`
      SELECT TOP 1 ai.id
      FROM application_instance ai
      WHERE ai.app_identifier = @application_identifier;
    `);

  const applicationInstanceId = result.recordset[0]?.id;

  if (!applicationInstanceId) {
    throw new Error('Application instance was not found for the configured application identifier');
  }

  return Number(applicationInstanceId);
}

function normalizeAccessPrincipal(principal) {
  return normalizeClientPrincipal(principal);
}

function getPrincipalOwnerObjectId(principal) {
  const normalizedPrincipal = normalizeAccessPrincipal(principal);
  const ownerObjectId = String(normalizedPrincipal?.objectId ?? normalizedPrincipal?.userId ?? '').trim();

  return ownerObjectId || null;
}

function getOwnerMetadata(principal) {
  const normalizedPrincipal = normalizeAccessPrincipal(principal);

  return {
    ownerObjectId: getPrincipalOwnerObjectId(normalizedPrincipal),
    ownerUserDetails: String(normalizedPrincipal?.userDetails ?? '').trim() || null,
    ownerDisplayName: String(normalizedPrincipal?.displayName ?? '').trim() || null,
  };
}

function normalizeVisibilityFilter(value, defaultValue = TREE_VISIBILITY_BOTH) {
  const normalizedValue = String(value ?? '').trim().toLowerCase();

  if (normalizedValue === TREE_VISIBILITY_PUBLIC || normalizedValue === TREE_VISIBILITY_PRIVATE || normalizedValue === TREE_VISIBILITY_BOTH) {
    return normalizedValue;
  }

  return defaultValue;
}

function mapTreeRecord(row) {
  return {
    id: String(row.id),
    name: String(row.name ?? row.displayName ?? '').trim() || `Tree ${row.id}`,
    displayName: String(row.displayName ?? row.name ?? '').trim() || `Tree ${row.id}`,
    description: normalizeTreeDescription(row.description),
    isDescriptionPublished: Boolean(row.isDescriptionPublished),
    isPrivate: Boolean(row.isPrivate),
    deletedAt: row.deletedAt ?? null,
    ownerObjectId: String(row.ownerObjectId ?? '').trim() || null,
    ownerUserDetails: String(row.ownerUserDetails ?? '').trim() || null,
    ownerDisplayName: String(row.ownerDisplayName ?? '').trim() || null,
  };
}

function isOwnedByPrincipal(tree, principal) {
  const ownerObjectId = String(tree?.ownerObjectId ?? '').trim();
  const principalOwnerObjectId = getPrincipalOwnerObjectId(principal);

  return Boolean(ownerObjectId && principalOwnerObjectId && ownerObjectId === principalOwnerObjectId);
}

function canViewTree(tree, principal, visibility) {
  const normalizedVisibility = normalizeVisibilityFilter(visibility);

  if (tree?.isPrivate) {
    return normalizedVisibility !== TREE_VISIBILITY_PUBLIC && isOwnedByPrincipal(tree, principal);
  }

  return normalizedVisibility !== TREE_VISIBILITY_PRIVATE;
}

function canWriteTree(tree, principal) {
  if (!tree?.isPrivate) {
    return true;
  }

  return isOwnedByPrincipal(tree, principal);
}

function filterTreesForAccess(treeList, { principal = null, visibility = TREE_VISIBILITY_BOTH, enforceAccess = false } = {}) {
  if (!enforceAccess) {
    return treeList;
  }

  return treeList.filter((tree) => canViewTree(tree, principal, visibility));
}

async function assertScopedTree(treeId, options = {}) {
  const {
    principal = null,
    visibility = TREE_VISIBILITY_BOTH,
    requireWriteAccess = false,
    enforceAccess = false,
    includeDeleted = false,
  } = options;
  const result = await new sql.Request()
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .input('include_deleted', sql.Bit, includeDeleted ? 1 : 0)
    .query(`
      SELECT TOP 1
        ti.id,
        ti.display_name AS displayName,
        ti.description,
        CAST(COALESCE(ti.description_published_to_agent, 0) AS BIT) AS isDescriptionPublished,
        CAST(COALESCE(ti.is_private, 0) AS BIT) AS isPrivate,
        ti.deleted_at AS deletedAt,
        ti.owner_object_id AS ownerObjectId,
        ti.owner_user_details AS ownerUserDetails,
        ti.owner_display_name AS ownerDisplayName
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ti.id = @tree_instance_id
        AND ai.app_identifier = @application_identifier
        AND (@include_deleted = 1 OR ti.deleted_at IS NULL);
    `);

  const tree = result.recordset[0] ? mapTreeRecord(result.recordset[0]) : null;

  if (!tree) {
    throw new Error('Tree was not found for the active application instance');
  }

  if (enforceAccess && !canViewTree(tree, principal, visibility)) {
    throw new Error('Tree was not found for the active application instance');
  }

  if (enforceAccess && requireWriteAccess && !canWriteTree(tree, principal)) {
    throw new Error('Tree was not found for the active application instance');
  }

  return tree;
}

export async function assertTreeAccess(treeId, options = {}) {
  return assertScopedTree(treeId, {
    ...options,
    enforceAccess: true,
  });
}

function normalizeGeneratedTreeText(value) {
  return String(value ?? '').trim();
}

function normalizeGeneratedTreeNotes(value) {
  return String(value ?? '').trim();
}

async function upsertTreeNodeDetails(request, treeNodeId, notes) {
  await request
    .input('tree_node_id', sql.Int, treeNodeId)
    .input('notes', sql.NVarChar(sql.MAX), notes)
    .query(`
      MERGE tree_node_details AS target
      USING (SELECT @tree_node_id AS tree_node_id) AS source
        ON target.tree_node_id = source.tree_node_id
      WHEN MATCHED THEN
        UPDATE SET
          notes = @notes,
          updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (tree_node_id, notes, created_at, updated_at)
        VALUES (@tree_node_id, @notes, SYSUTCDATETIME(), SYSUTCDATETIME());
    `);
}

async function insertGeneratedNodeBranch({ transaction, treeInstanceId, parentId, nodes, startingSortOrder = 0 }) {
  let insertedCount = 0;

  for (const [nodeIndex, node] of nodes.entries()) {
    const isLeafNode = !Array.isArray(node.children);
    const nodeText = normalizeGeneratedTreeText(node.title);
    const insertResult = await new sql.Request(transaction)
      .input('tree_instance_id', sql.Int, treeInstanceId)
      .input('parent_id', sql.Int, parentId)
      .input('text', sql.NVarChar(255), nodeText)
      .input('is_leaf_node', sql.Bit, isLeafNode ? 1 : 0)
      .input('is_expanded', sql.Bit, isLeafNode ? 0 : 1)
      .input('draggable', sql.Bit, 1)
      .input('sort_order', sql.Int, startingSortOrder + nodeIndex)
      .query(`
        DECLARE @createdNodes TABLE (createdNodeId INT);

        INSERT INTO tree_nodes (tree_instance_id, parent_id, text, is_leaf_node, is_expanded, draggable, sort_order)
        OUTPUT INSERTED.id INTO @createdNodes (createdNodeId)
        VALUES (@tree_instance_id, @parent_id, @text, @is_leaf_node, @is_expanded, @draggable, @sort_order);

        SELECT createdNodeId FROM @createdNodes;
      `);

    const createdNodeId = Number(insertResult.recordset[0]?.createdNodeId);

    if (!createdNodeId) {
      throw new Error('A generated tree node could not be inserted.');
    }

    insertedCount += 1;

    if (isLeafNode) {
      await upsertTreeNodeDetails(
        new sql.Request(transaction),
        createdNodeId,
        normalizeGeneratedTreeNotes(node.notes),
      );
      continue;
    }

    insertedCount += await insertGeneratedNodeBranch({
      transaction,
      treeInstanceId,
      parentId: createdNodeId,
      nodes: node.children,
      startingSortOrder: 0,
    });
  }

  return insertedCount;
}

async function getScopedTreeAttachmentBlobs(treeId) {
  const result = await new sql.Request()
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .input('include_deleted', sql.Bit, 0)
    .query(`
      SELECT files.blob_name AS blobName
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ti.id = @tree_instance_id
        AND ai.app_identifier = @application_identifier
        AND (@include_deleted = 1 OR ti.deleted_at IS NULL)
        AND (@include_deleted = 1 OR tn.deleted_at IS NULL);
    `);

  return result.recordset;
}

export async function getTreeList(options = {}) {
  const {
    principal = null,
    visibility = TREE_VISIBILITY_BOTH,
    enforceAccess = false,
    includeDeleted = false,
    deletedOnly = false,
  } = options;
  const query = `
    SELECT
      CAST(ti.id AS VARCHAR(10)) AS id,
      COALESCE(NULLIF(ti.display_name, ''), root_node.text, CONCAT('Tree ', ti.id)) AS name,
      CAST(COALESCE(ti.description, '') AS NVARCHAR(MAX)) AS description,
      CAST(COALESCE(ti.description_published_to_agent, 0) AS BIT) AS isDescriptionPublished,
      CAST(COALESCE(ti.is_private, 0) AS BIT) AS isPrivate,
      ti.deleted_at AS deletedAt,
      ti.owner_object_id AS ownerObjectId,
      ti.owner_user_details AS ownerUserDetails,
      ti.owner_display_name AS ownerDisplayName,
      ti.display_name AS displayName
    FROM tree_instance ti
    INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
    OUTER APPLY (
      SELECT TOP 1 tn.text
      FROM tree_nodes tn
      WHERE tn.tree_instance_id = ti.id AND tn.parent_id IS NULL AND tn.deleted_at IS NULL
      ORDER BY tn.sort_order, tn.id
    ) root_node
    WHERE ai.app_identifier = @application_identifier
      AND (
        (@deleted_only = 1 AND ti.deleted_at IS NOT NULL)
        OR (@deleted_only = 0 AND (@include_deleted = 1 OR ti.deleted_at IS NULL))
      )
    ORDER BY ti.updated_at DESC, ti.id DESC;`;

  return withSqlConnection(async () => {
    const result = await new sql.Request()
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
      .input('include_deleted', sql.Bit, includeDeleted ? 1 : 0)
      .input('deleted_only', sql.Bit, deletedOnly ? 1 : 0)
      .query(query);

    return filterTreesForAccess(
      result.recordset.map((row) => mapTreeRecord(row)),
      { principal, visibility, enforceAccess },
    );
  });
}

export async function getAllowedTreeIds(options = {}) {
  const treeList = await getTreeList(options);
  return treeList.map((tree) => String(tree.id));
}

export async function getTreeForPopulation(treeId, options = {}) {
  return withSqlConnection(async () => {
    const scopedTree = await assertScopedTree(treeId, options);

    return {
      id: String(scopedTree.id),
      name: String(scopedTree.displayName ?? '').trim() || `Tree ${treeId}`,
      description: normalizeTreeDescription(scopedTree.description),
      isDescriptionPublished: Boolean(scopedTree.isDescriptionPublished),
      isPrivate: Boolean(scopedTree.isPrivate),
      ownerObjectId: scopedTree.ownerObjectId ?? null,
      ownerUserDetails: scopedTree.ownerUserDetails ?? null,
      ownerDisplayName: scopedTree.ownerDisplayName ?? null,
    };
  });
}

export async function createTree({ name, principal = null }) {
  const normalizedName = normalizeTreeName(name);
  const ownerMetadata = getOwnerMetadata(principal);

  if (!normalizedName) {
    throw new Error('Tree name is required');
  }

  if (!ownerMetadata.ownerObjectId) {
    throw new Error('An authenticated owner is required to create a private tree');
  }

  return withSqlConnection(async () => {
    const applicationInstanceId = await getScopedApplicationInstanceId();
    const insertResult = await new sql.Request()
      .input('application_instance_id', sql.Int, applicationInstanceId)
      .input('tree_key', sql.NVarChar(100), buildTreeKey(normalizedName))
      .input('display_name', sql.NVarChar(200), normalizedName)
      .input('is_private', sql.Bit, 1)
      .input('owner_object_id', sql.NVarChar(100), ownerMetadata.ownerObjectId)
      .input('owner_user_details', sql.NVarChar(320), ownerMetadata.ownerUserDetails)
      .input('owner_display_name', sql.NVarChar(200), ownerMetadata.ownerDisplayName)
      .query(`
        DECLARE @createdTrees TABLE (createdTreeId INT);

        INSERT INTO tree_instance (
          application_instance_id,
          tree_key,
          display_name,
          is_private,
          owner_object_id,
          owner_user_details,
          owner_display_name,
          is_active
        )
        OUTPUT INSERTED.id INTO @createdTrees (createdTreeId)
        VALUES (
          @application_instance_id,
          @tree_key,
          @display_name,
          @is_private,
          @owner_object_id,
          @owner_user_details,
          @owner_display_name,
          1
        );

        SELECT createdTreeId FROM @createdTrees;
      `);

    const treeInstanceId = Number(insertResult.recordset[0]?.createdTreeId);

    if (!treeInstanceId) {
      throw new Error('Tree could not be created');
    }

    await new sql.Request()
      .input('tree_instance_id', sql.Int, treeInstanceId)
      .input('setting_key', sql.NVarChar(100), 'nodes.max_depth')
      .input('setting_value', sql.NVarChar(500), DEFAULT_TREE_MAX_DEPTH)
      .query(`
        INSERT INTO tree_setting (tree_instance_id, setting_key, setting_value)
        VALUES (@tree_instance_id, @setting_key, @setting_value);
      `);

    return {
      id: String(treeInstanceId),
      name: normalizedName,
      description: '',
      isDescriptionPublished: false,
      isPrivate: true,
      ownerObjectId: ownerMetadata.ownerObjectId,
      ownerUserDetails: ownerMetadata.ownerUserDetails,
      ownerDisplayName: ownerMetadata.ownerDisplayName,
    };
  });
}

export async function updateTreeTitle({ treeId, name, principal = null, enforceAccess = false }) {
  const normalizedName = normalizeTreeName(name);

  if (!normalizedName) {
    throw new Error('Tree name is required');
  }

  return withSqlConnection(async () => {
    const scopedTree = await assertScopedTree(treeId, {
      principal,
      requireWriteAccess: true,
      enforceAccess,
    });
    const currentName = String(scopedTree.displayName ?? '').trim() || `Tree ${treeId}`;

    if (normalizedName === currentName) {
      return {
        id: String(treeId),
        name: currentName,
      };
    }

    const updateResult = await new sql.Request()
      .input('tree_instance_id', sql.Int, Number(treeId))
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
      .input('display_name', sql.NVarChar(200), normalizedName)
      .query(`
        UPDATE ti
        SET display_name = @display_name,
            updated_at = SYSUTCDATETIME()
        FROM tree_instance ti
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ti.id = @tree_instance_id
          AND ai.app_identifier = @application_identifier;
      `);

    if (!updateResult.rowsAffected[0]) {
      throw new Error('Tree was not found for the active application instance');
    }

    return {
      id: String(treeId),
      name: normalizedName,
      isPrivate: Boolean(scopedTree.isPrivate),
      ownerObjectId: scopedTree.ownerObjectId ?? null,
      ownerUserDetails: scopedTree.ownerUserDetails ?? null,
      ownerDisplayName: scopedTree.ownerDisplayName ?? null,
    };
  });
}

export async function updateTreeVisibility({ treeId, isPrivate, principal = null, enforceAccess = false }) {
  const nextIsPrivate = Boolean(isPrivate);

  return withSqlConnection(async () => {
    const scopedTree = await assertScopedTree(treeId, {
      principal,
      requireWriteAccess: true,
      enforceAccess,
    });
    const ownerMetadata = nextIsPrivate
      ? getOwnerMetadata(principal)
      : {
        ownerObjectId: scopedTree.ownerObjectId ?? null,
        ownerUserDetails: scopedTree.ownerUserDetails ?? null,
        ownerDisplayName: scopedTree.ownerDisplayName ?? null,
      };

    if (nextIsPrivate && !ownerMetadata.ownerObjectId) {
      throw new Error('An authenticated owner is required to make a tree private');
    }

    await new sql.Request()
      .input('tree_instance_id', sql.Int, Number(treeId))
      .input('is_private', sql.Bit, nextIsPrivate ? 1 : 0)
      .input('owner_object_id', sql.NVarChar(100), ownerMetadata.ownerObjectId)
      .input('owner_user_details', sql.NVarChar(320), ownerMetadata.ownerUserDetails)
      .input('owner_display_name', sql.NVarChar(200), ownerMetadata.ownerDisplayName)
      .query(`
        UPDATE tree_instance
        SET
          is_private = @is_private,
          owner_object_id = CASE
            WHEN @is_private = 1 THEN @owner_object_id
            ELSE COALESCE(owner_object_id, @owner_object_id)
          END,
          owner_user_details = CASE
            WHEN @is_private = 1 THEN @owner_user_details
            ELSE COALESCE(owner_user_details, @owner_user_details)
          END,
          owner_display_name = CASE
            WHEN @is_private = 1 THEN @owner_display_name
            ELSE COALESCE(owner_display_name, @owner_display_name)
          END
        WHERE id = @tree_instance_id;
      `);

    return {
      id: String(treeId),
      name: String(scopedTree.displayName ?? '').trim() || `Tree ${treeId}`,
      description: normalizeTreeDescription(scopedTree.description),
      isDescriptionPublished: Boolean(scopedTree.isDescriptionPublished),
      isPrivate: nextIsPrivate,
      ownerObjectId: ownerMetadata.ownerObjectId,
      ownerUserDetails: ownerMetadata.ownerUserDetails,
      ownerDisplayName: ownerMetadata.ownerDisplayName,
    };
  });
}

export async function updateTreeDescription({ treeId, description, principal = null, enforceAccess = false }) {
  const normalizedDescription = normalizeTreeDescription(description);

  return withSqlConnection(async () => {
    const scopedTree = await assertScopedTree(treeId, {
      principal,
      requireWriteAccess: true,
      enforceAccess,
    });
    const nextDescription = normalizedDescription;
    const currentDescription = normalizeTreeDescription(scopedTree.description);
    const currentPublishedState = Boolean(scopedTree.isDescriptionPublished);

    if (nextDescription === currentDescription && !currentPublishedState) {
      return {
        id: String(treeId),
        name: String(scopedTree.displayName ?? '').trim() || `Tree ${treeId}`,
        description: currentDescription,
        isDescriptionPublished: false,
        isPrivate: Boolean(scopedTree.isPrivate),
        ownerObjectId: scopedTree.ownerObjectId ?? null,
        ownerUserDetails: scopedTree.ownerUserDetails ?? null,
        ownerDisplayName: scopedTree.ownerDisplayName ?? null,
      };
    }

    const updateResult = await new sql.Request()
      .input('tree_instance_id', sql.Int, Number(treeId))
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
      .input('description', sql.NVarChar(sql.MAX), nextDescription)
      .query(`
        UPDATE ti
        SET description = @description,
            description_published_to_agent = 0,
            updated_at = SYSUTCDATETIME()
        FROM tree_instance ti
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ti.id = @tree_instance_id
          AND ai.app_identifier = @application_identifier;
      `);

    if (!updateResult.rowsAffected[0]) {
      throw new Error('Tree was not found for the active application instance');
    }

    return {
      id: String(treeId),
      name: String(scopedTree.displayName ?? '').trim() || `Tree ${treeId}`,
      description: nextDescription,
      isDescriptionPublished: false,
      isPrivate: Boolean(scopedTree.isPrivate),
      ownerObjectId: scopedTree.ownerObjectId ?? null,
      ownerUserDetails: scopedTree.ownerUserDetails ?? null,
      ownerDisplayName: scopedTree.ownerDisplayName ?? null,
    };
  });
}

export async function updateTreeDescriptions(treeDescriptions) {
  const normalizedUpdates = Array.isArray(treeDescriptions)
    ? treeDescriptions
      .map((entry) => ({
        treeId: Number.parseInt(String(entry?.treeId ?? ''), 10),
        description: normalizeTreeDescription(entry?.description),
      }))
      .filter((entry) => Number.isFinite(entry.treeId))
    : [];

  if (normalizedUpdates.length === 0) {
    return [];
  }

  return withSqlConnection(async () => {
    for (const entry of normalizedUpdates) {
      await updateTreeDescription(entry);
    }

    return normalizedUpdates.map((entry) => ({
      treeId: String(entry.treeId),
      description: entry.description,
    }));
  });
}

export async function updateTreeDescriptionPublishedStates(treeStates) {
  const normalizedStates = Array.isArray(treeStates)
    ? treeStates
      .map((entry) => ({
        treeId: Number.parseInt(String(entry?.treeId ?? ''), 10),
        isDescriptionPublished: Boolean(entry?.isDescriptionPublished),
      }))
      .filter((entry) => Number.isFinite(entry.treeId))
    : [];

  if (normalizedStates.length === 0) {
    return [];
  }

  return withSqlConnection(async () => {
    for (const entry of normalizedStates) {
      const scopedTree = await assertScopedTree(entry.treeId);

      if (Boolean(scopedTree.isDescriptionPublished) === entry.isDescriptionPublished) {
        continue;
      }

      await new sql.Request()
        .input('tree_instance_id', sql.Int, entry.treeId)
        .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
        .input('description_published_to_agent', sql.Bit, entry.isDescriptionPublished)
        .query(`
          UPDATE ti
          SET description_published_to_agent = @description_published_to_agent,
              updated_at = SYSUTCDATETIME()
          FROM tree_instance ti
          INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
          WHERE ti.id = @tree_instance_id
            AND ai.app_identifier = @application_identifier;
        `);
    }

    return normalizedStates.map((entry) => ({
      treeId: String(entry.treeId),
      isDescriptionPublished: entry.isDescriptionPublished,
    }));
  });
}

export async function deleteTree({ treeId, principal = null, enforceAccess = false }) {
  return withSqlConnection(async () => {
    await assertScopedTree(treeId, {
      principal,
      requireWriteAccess: true,
      enforceAccess,
    });

    const deletedAt = new Date();
    const deleteResult = await new sql.Request()
      .input('tree_instance_id', sql.Int, Number(treeId))
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
      .input('deleted_at', sql.DateTime2, deletedAt)
      .query(`
        UPDATE ti
        SET deleted_at = COALESCE(ti.deleted_at, @deleted_at),
            updated_at = @deleted_at
        FROM tree_instance ti
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ti.id = @tree_instance_id
          AND ai.app_identifier = @application_identifier
          AND ti.deleted_at IS NULL;
      `);

    if (!deleteResult.rowsAffected[0]) {
      throw new Error('Tree was not found for the active application instance');
    }

    return { success: true };
  });
}

export async function purgeTree({ treeId, principal = null, enforceAccess = false }) {
  return withSqlConnection(async () => {
    const scopedTree = await assertScopedTree(treeId, {
      principal,
      requireWriteAccess: true,
      enforceAccess,
      includeDeleted: true,
    });

    if (!scopedTree.deletedAt) {
      throw new Error('Tree must be soft-deleted before it can be purged');
    }

    const attachments = await new sql.Request()
      .input('tree_instance_id', sql.Int, Number(treeId))
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
      .query(`
        SELECT files.blob_name AS blobName
        FROM tree_node_detail_files files
        INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
        INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ti.id = @tree_instance_id
          AND ai.app_identifier = @application_identifier;
      `);

    for (const attachment of attachments.recordset) {
      await deleteNodeAttachmentBlobIfExists(attachment.blobName);
    }

    const purgeResult = await new sql.Request()
      .input('tree_instance_id', sql.Int, Number(treeId))
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
      .query(`
        DELETE ti
        FROM tree_instance ti
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ti.id = @tree_instance_id
          AND ai.app_identifier = @application_identifier
          AND ti.deleted_at IS NOT NULL;
      `);

    if (!purgeResult.rowsAffected[0]) {
      throw new Error('Tree was not found for purge');
    }

    return { success: true };
  });
}

export async function appendGeneratedNodesToTree({ treeId, generatedNodes }) {
  return withSqlConnection(async () => {
    await assertScopedTree(treeId);

    const transaction = new sql.Transaction();

    try {
      await transaction.begin();

      const rootSortOrderResult = await new sql.Request(transaction)
        .input('tree_instance_id', sql.Int, Number(treeId))
        .query(`
          SELECT ISNULL(MAX(sort_order), -1) AS maxRootSortOrder
          FROM tree_nodes
          WHERE tree_instance_id = @tree_instance_id
            AND parent_id IS NULL;
        `);

      const maxRootSortOrder = Number(rootSortOrderResult.recordset[0]?.maxRootSortOrder ?? -1);
      const totalNodeCount = await insertGeneratedNodeBranch({
        transaction,
        treeInstanceId: Number(treeId),
        parentId: null,
        nodes: generatedNodes,
        startingSortOrder: maxRootSortOrder + 1,
      });

      await new sql.Request(transaction)
        .input('tree_instance_id', sql.Int, Number(treeId))
        .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
        .query(`
          UPDATE ti
          SET updated_at = SYSUTCDATETIME()
          FROM tree_instance ti
          INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
          WHERE ti.id = @tree_instance_id
            AND ai.app_identifier = @application_identifier;
        `);

      await transaction.commit();

      return {
        treeId: String(treeId),
        rootNodeCount: Array.isArray(generatedNodes) ? generatedNodes.length : 0,
        totalNodeCount,
      };
    } catch (error) {
      if (transaction._aborted !== true) {
        await transaction.rollback();
      }

      throw error;
    }
  });
}

export async function getTreeRoutingProfiles(options = {}) {
  const treeList = await getTreeList(options);

  if (treeList.length === 0) {
    return [];
  }

  const nodeQuery = `
    WITH RecursiveTree AS (
      SELECT
        ti.id AS tree_id,
        tn.id,
        tn.parent_id,
        tn.text,
        tn.is_leaf_node,
        0 AS depth,
        CAST(RIGHT(REPLICATE('0', 3) + CAST(tn.sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS path,
        CAST(tn.text AS NVARCHAR(MAX)) AS breadcrumb
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      INNER JOIN tree_nodes tn ON tn.tree_instance_id = ti.id
      WHERE ai.app_identifier = @application_identifier
        AND ti.deleted_at IS NULL
        AND tn.deleted_at IS NULL
        AND tn.parent_id IS NULL

      UNION ALL

      SELECT
        rt.tree_id,
        tn.id,
        tn.parent_id,
        tn.text,
        tn.is_leaf_node,
        rt.depth + 1 AS depth,
        CAST(rt.path + '-' + RIGHT(REPLICATE('0', 3) + CAST(tn.sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS path,
        CAST(rt.breadcrumb + N' > ' + tn.text AS NVARCHAR(MAX)) AS breadcrumb
      FROM tree_nodes tn
      INNER JOIN RecursiveTree rt ON tn.parent_id = rt.id
      WHERE tn.deleted_at IS NULL
    )
    SELECT
      CAST(tree_id AS VARCHAR(10)) AS treeId,
      CAST(id AS VARCHAR(10)) AS nodeId,
      depth,
      text,
      CAST(is_leaf_node AS bit) AS isLeafNode,
      breadcrumb,
      path
    FROM RecursiveTree
    ORDER BY tree_id, path;`;

  const attachmentQuery = `
    WITH RecursiveTree AS (
      SELECT
        ti.id AS tree_id,
        tn.id,
        tn.parent_id,
        tn.text,
        0 AS depth,
        CAST(RIGHT(REPLICATE('0', 3) + CAST(tn.sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS path,
        CAST(tn.text AS NVARCHAR(MAX)) AS breadcrumb
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      INNER JOIN tree_nodes tn ON tn.tree_instance_id = ti.id
      WHERE ai.app_identifier = @application_identifier
        AND ti.deleted_at IS NULL
        AND tn.deleted_at IS NULL
        AND tn.parent_id IS NULL

      UNION ALL

      SELECT
        rt.tree_id,
        tn.id,
        tn.parent_id,
        tn.text,
        rt.depth + 1 AS depth,
        CAST(rt.path + '-' + RIGHT(REPLICATE('0', 3) + CAST(tn.sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS path,
        CAST(rt.breadcrumb + N' > ' + tn.text AS NVARCHAR(MAX)) AS breadcrumb
      FROM tree_nodes tn
      INNER JOIN RecursiveTree rt ON tn.parent_id = rt.id
      WHERE tn.deleted_at IS NULL
    )
    SELECT
      CAST(rt.tree_id AS VARCHAR(10)) AS treeId,
      CAST(rt.id AS VARCHAR(10)) AS nodeId,
      CAST(rt.text AS NVARCHAR(255)) AS nodeText,
      CAST(rt.breadcrumb AS NVARCHAR(MAX)) AS breadcrumb,
      rt.depth,
      CAST(files.original_file_name AS NVARCHAR(260)) AS fileName,
      files.created_at AS createdAt
    FROM RecursiveTree rt
    INNER JOIN tree_node_detail_files files ON files.tree_node_id = rt.id
    ORDER BY rt.tree_id, rt.path, files.created_at DESC, files.id DESC;`;

  function uniqueByValue(values, maxItems) {
    const uniqueValues = [];
    const seenValues = new Set();

    values.forEach((value) => {
      const normalizedValue = String(value ?? '').trim();

      if (!normalizedValue) {
        return;
      }

      const key = normalizedValue.toLowerCase();

      if (seenValues.has(key)) {
        return;
      }

      seenValues.add(key);
      uniqueValues.push(normalizedValue);
    });

    return uniqueValues.slice(0, maxItems);
  }

  return withSqlConnection(async () => {
    const [nodeResult, attachmentResult] = await Promise.all([
      new sql.Request()
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
        .query(nodeQuery),
      new sql.Request()
        .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
        .query(attachmentQuery),
    ]);

    const nodesByTreeId = new Map();
    const attachmentsByTreeId = new Map();

    nodeResult.recordset.forEach((row) => {
      const treeId = String(row.treeId);

      if (!nodesByTreeId.has(treeId)) {
        nodesByTreeId.set(treeId, []);
      }

      nodesByTreeId.get(treeId).push({
        nodeId: String(row.nodeId),
        depth: Number(row.depth),
        text: String(row.text ?? '').trim(),
        isLeafNode: Boolean(row.isLeafNode),
        breadcrumb: String(row.breadcrumb ?? '').trim(),
        path: String(row.path ?? ''),
      });
    });

    attachmentResult.recordset.forEach((row) => {
      const treeId = String(row.treeId);

      if (!attachmentsByTreeId.has(treeId)) {
        attachmentsByTreeId.set(treeId, []);
      }

      attachmentsByTreeId.get(treeId).push({
        nodeId: String(row.nodeId),
        nodeText: String(row.nodeText ?? '').trim(),
        breadcrumb: String(row.breadcrumb ?? '').trim(),
        depth: Number(row.depth),
        fileName: String(row.fileName ?? '').trim(),
      });
    });

    return treeList.map((tree) => {
      const nodes = nodesByTreeId.get(String(tree.id)) ?? [];
      const attachments = attachmentsByTreeId.get(String(tree.id)) ?? [];
      const topLevelTopics = nodes
        .filter((node) => node.depth === 1)
        .map((node) => node.text)
        .filter(Boolean)
        .slice(0, 6);
      const supportingTopics = nodes
        .filter((node) => node.depth === 2)
        .map((node) => node.text)
        .filter(Boolean)
        .slice(0, 10);
      const nonLeafTitles = uniqueByValue(
        nodes.filter((node) => !node.isLeafNode).map((node) => node.text),
        MAX_NON_LEAF_TITLES,
      );
      const leafNodes = [...nodes]
        .filter((node) => node.isLeafNode)
        .sort((left, right) => {
          if (right.depth !== left.depth) {
            return right.depth - left.depth;
          }

          return String(left.path ?? '').localeCompare(String(right.path ?? ''));
        });
      const leafTitleExemplars = uniqueByValue(leafNodes.map((node) => node.text), MAX_LEAF_TITLE_EXEMPLARS);
      const breadcrumbExemplars = uniqueByValue(leafNodes.map((node) => node.breadcrumb), MAX_BREADCRUMB_EXEMPLARS);
      const attachmentFileNameExemplars = uniqueByValue(
        attachments.map((attachment) => attachment.fileName),
        MAX_ATTACHMENT_FILE_NAME_EXEMPLARS,
      );

      return {
        ...tree,
        topLevelTopics,
        supportingTopics,
        nonLeafTitles,
        leafTitleExemplars,
        breadcrumbExemplars,
        attachmentFileNameExemplars,
      };
    });
  });
}

export async function getTreeRoutingProfile(treeId, options = {}) {
  const scopedTree = await assertScopedTree(treeId, options);
  const treeProfiles = await getTreeRoutingProfiles(options);
  const matchingTree = treeProfiles.find((tree) => String(tree.id) === String(treeId));

  if (!matchingTree) {
    return {
      id: String(scopedTree.id),
      name: String(scopedTree.displayName ?? '').trim() || `Tree ${treeId}`,
      description: normalizeTreeDescription(scopedTree.description),
      isPrivate: Boolean(scopedTree.isPrivate),
      ownerObjectId: scopedTree.ownerObjectId ?? null,
      ownerUserDetails: scopedTree.ownerUserDetails ?? null,
      ownerDisplayName: scopedTree.ownerDisplayName ?? null,
      topLevelTopics: [],
      supportingTopics: [],
      nonLeafTitles: [],
      leafTitleExemplars: [],
      breadcrumbExemplars: [],
      attachmentFileNameExemplars: [],
    };
  }

  return matchingTree;
}