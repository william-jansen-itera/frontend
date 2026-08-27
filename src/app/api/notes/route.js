
import { NextResponse } from 'next/server';
import { deleteNodeAttachmentBlobIfExists, uploadNodeAttachment } from '@/server/utils/blobStorage';
import {
  generateChatLeafPathPlan,
  generateChildTitlesFromBreadcrumb,
  generateLeafNotesFromChatAnswer,
  generateLeafNotesDraft,
  selectChatLeafAnchorCandidate,
} from '@/server/utils/chatService';
import { parseClientPrincipal } from '@/server/utils/auth';
import { sql, withSqlConnection } from '@/server/utils/sql';
import { assertTreeAccess, getTreeList } from '@/server/utils/treeCatalog';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  '.csv',
  '.doc',
  '.docx',
  '.gif',
  '.html',
  '.jpeg',
  '.jpg',
  '.json',
  '.md',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.txt',
  '.webp',
  '.xls',
  '.xlsx',
]);

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

async function queryTreeData(treeInstanceId) {
  const query = `WITH RecursiveTree AS (
      SELECT
        id,
        parent_id,
        text,
        is_leaf_node,
        is_expanded,
        draggable,
        sort_order,
        CAST(RIGHT(REPLICATE('0', 3) + CAST(sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS path,
        0 AS _depth
      FROM tree_nodes
      WHERE tree_instance_id = @tree_instance_id
        AND parent_id IS NULL
      UNION ALL
      SELECT
        t.id,
        t.parent_id,
        t.text,
        t.is_leaf_node,
        t.is_expanded,
        t.draggable,
        t.sort_order,
        CAST(rt.path + '-' + RIGHT(REPLICATE('0', 3) + CAST(t.sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS path,
        rt._depth + 1 AS _depth
      FROM tree_nodes t
      INNER JOIN RecursiveTree rt ON t.parent_id = rt.id
      WHERE t.tree_instance_id = @tree_instance_id
    )
    SELECT
      CAST(id AS VARCHAR(10)) AS id,
      CAST(parent_id AS VARCHAR(10)) AS parent,
      text AS name,
      is_leaf_node AS isLeafNode,
      is_expanded AS isExpanded,
      draggable,
      sort_order,
      _depth,
      path
    FROM RecursiveTree
    ORDER BY path;`;

  const result = await new sql.Request()
    .input('tree_instance_id', sql.Int, parseInt(treeInstanceId, 10))
    .query(query);

  return result.recordset;
}

async function getTreeData(treeInstanceId) {
  return withSqlConnection(async () => {
    return queryTreeData(treeInstanceId);
  });
}

async function queryTreeNode(treeInstanceId, nodeId, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, parseInt(treeInstanceId, 10))
    .input('id', sql.Int, parseInt(nodeId, 10))
    .query(`
      SELECT TOP 1
        CAST(id AS VARCHAR(10)) AS id,
        text AS name,
        is_leaf_node AS isLeafNode
      FROM tree_nodes
      WHERE tree_instance_id = @tree_instance_id AND id = @id;
    `);

  return result.recordset[0] ?? null;
}

async function queryNodeDetails(treeInstanceId, nodeId, transaction = null, knownNode = null) {
  const node = knownNode ?? await queryTreeNode(treeInstanceId, nodeId, transaction);
  if (!node) {
    return null;
  }

  if (!node.isLeafNode) {
    return {
      id: node.id,
      name: node.name,
      notes: '',
      attachments: [],
      isLeafNode: false,
    };
  }

  const detailResult = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, parseInt(treeInstanceId, 10))
    .input('id', sql.Int, parseInt(nodeId, 10))
    .query(`
      SELECT
        CAST(tn.id AS VARCHAR(10)) AS id,
        tn.text AS name,
        ISNULL(tnd.notes, '') AS notes
      FROM tree_nodes tn
      LEFT JOIN tree_node_details tnd ON tnd.tree_node_id = tn.id
      WHERE tn.tree_instance_id = @tree_instance_id AND tn.id = @id;
    `);

  const details = detailResult.recordset[0] ?? null;
  if (!details) {
    return {
      id: node.id,
      name: node.name,
      notes: '',
      attachments: [],
      isLeafNode: true,
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
        files.created_at AS createdAt
      FROM tree_node_detail_files files
      INNER JOIN tree_node_details details ON details.tree_node_id = files.tree_node_id
      INNER JOIN tree_nodes tn ON tn.id = details.tree_node_id
      WHERE tn.tree_instance_id = @tree_instance_id AND tn.id = @id
      ORDER BY files.created_at DESC, files.id DESC;
    `);

  return {
    ...details,
    isLeafNode: true,
    attachments: attachmentResult.recordset,
  };
}

async function getNodeDetails(treeInstanceId, nodeId) {
  return withSqlConnection(async () => {
    return queryNodeDetails(treeInstanceId, nodeId);
  });
}

async function getTreeSettings(treeInstanceId) {
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

async function queryTreeSummary(treeInstanceId, transaction = null) {
  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, parseInt(treeInstanceId, 10))
    .query(`
      SELECT TOP 1 COALESCE(NULLIF(display_name, ''), CONCAT('Tree ', id)) AS treeName
      FROM tree_instance
      WHERE id = @tree_instance_id;
    `);

  return {
    treeName: String(result.recordset[0]?.treeName ?? '').trim() || `Tree ${treeInstanceId}`,
  };
}

async function getTreeMaxDepth(treeInstanceId) {
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

function createSqlRequest(transaction) {
  return transaction ? new sql.Request(transaction) : new sql.Request();
}

async function getTreeMaxDepthForRequest(treeInstanceId, transaction = null) {
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

async function getTreeCreateContext(treeInstanceId, parentId, transaction = null) {
  const query = `WITH RecursiveTree AS (
      SELECT
        id,
        parent_id,
        0 AS depth
      FROM tree_nodes
      WHERE tree_instance_id = @tree_instance_id
        AND parent_id IS NULL
      UNION ALL
      SELECT
        t.id,
        t.parent_id,
        rt.depth + 1 AS depth
      FROM tree_nodes t
      INNER JOIN RecursiveTree rt ON t.parent_id = rt.id
      WHERE t.tree_instance_id = @tree_instance_id
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
      AND parent_node.id = @parent_id;`;

  const result = await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('parent_id', sql.Int, parentId)
    .query(query);

  return result.recordset[0] ?? null;
}

function parseToolTreeId(toolName) {
  const match = String(toolName ?? '').trim().match(/_(\d+)$/);
  return match ? match[1] : '';
}

function buildBreadcrumbByNodeId(flatData) {
  const nodeById = new Map(flatData.map((node) => [String(node.id), node]));
  const breadcrumbByNodeId = new Map();

  flatData.forEach((node) => {
    const breadcrumbParts = [];
    let currentNode = node;

    while (currentNode) {
      const currentName = String(currentNode.name ?? '').trim();
      if (currentName) {
        breadcrumbParts.unshift(currentName);
      }

      const parentId = currentNode.parent;
      currentNode = parentId === null || parentId === undefined ? null : nodeById.get(String(parentId)) ?? null;
    }

    breadcrumbByNodeId.set(String(node.id), breadcrumbParts.join(' > '));
  });

  return breadcrumbByNodeId;
}

function buildBreadcrumbTitlesByNodeId(flatData) {
  const nodeById = new Map(flatData.map((node) => [String(node.id), node]));
  const breadcrumbTitlesByNodeId = new Map();

  flatData.forEach((node) => {
    const breadcrumbTitles = [];
    let currentNode = node;

    while (currentNode) {
      const currentName = String(currentNode.name ?? '').trim();

      if (currentName) {
        breadcrumbTitles.unshift(currentName);
      }

      const parentId = currentNode.parent;
      currentNode = parentId === null || parentId === undefined ? null : nodeById.get(String(parentId)) ?? null;
    }

    breadcrumbTitlesByNodeId.set(String(node.id), breadcrumbTitles);
  });

  return breadcrumbTitlesByNodeId;
}

function buildResolvedBreadcrumb(anchorBreadcrumbTitles, generatedPathTitles) {
  return [...anchorBreadcrumbTitles, ...generatedPathTitles].filter(Boolean).join(' > ');
}

async function getChatLeafPlacementContext(treeInstanceId) {
  const [flatData, treeSummary, maxDepth] = await Promise.all([
    queryTreeData(treeInstanceId),
    queryTreeSummary(treeInstanceId),
    getTreeMaxDepth(treeInstanceId),
  ]);
  const breadcrumbByNodeId = buildBreadcrumbByNodeId(flatData);
  const breadcrumbTitlesByNodeId = buildBreadcrumbTitlesByNodeId(flatData);
  const candidates = flatData
    .filter((node) => !node.isLeafNode)
    .map((node) => {
      const depth = Number(node._depth);
      const remainingDepthBudget = Number.isFinite(maxDepth) ? maxDepth - depth : Number.NaN;

      return {
        nodeId: String(node.id),
        breadcrumb: breadcrumbByNodeId.get(String(node.id)) || String(node.name ?? '').trim(),
        breadcrumbTitles: breadcrumbTitlesByNodeId.get(String(node.id)) ?? [],
        depth,
        remainingDepthBudget,
        directLeafPossible: remainingDepthBudget === 1,
      };
    })
    .filter((candidate) => candidate.depth >= 0)
    .filter((candidate) => Number.isFinite(candidate.remainingDepthBudget) && candidate.remainingDepthBudget >= 1)
    .map((node) => ({
      nodeId: node.nodeId,
      breadcrumb: node.breadcrumb,
      breadcrumbTitles: node.breadcrumbTitles,
      depth: node.depth,
      remainingDepthBudget: node.remainingDepthBudget,
      directLeafPossible: node.directLeafPossible,
    }));

  return {
    treeName: treeSummary.treeName,
    maxDepth,
    candidates,
  };
}

async function resolveChatLeafPlacement({ treeInstanceId, originalQuestion, broaderAnswer }) {
  const normalizedOriginalQuestion = String(originalQuestion ?? '').trim();
  const normalizedBroaderAnswer = String(broaderAnswer ?? '').trim();

  if (!normalizedOriginalQuestion || !normalizedBroaderAnswer) {
    throw new Error('The chat add action requires the original question and broader answer content.');
  }

  const { treeName, maxDepth, candidates } = await getChatLeafPlacementContext(treeInstanceId);

  let selectedCandidate = null;

  if (candidates.length > 0) {
    const selection = await selectChatLeafAnchorCandidate({
      treeName,
      originalQuestion: normalizedOriginalQuestion,
      broaderAnswer: normalizedBroaderAnswer,
      candidates,
    });

    if (selection.selectionDisposition === 'selected_anchor') {
      selectedCandidate = candidates.find((candidate) => candidate.nodeId === selection.selectedAnchorNodeId) ?? null;

      if (!selectedCandidate) {
        throw new Error('The selected anchor path was not valid for the target tree.');
      }

      if (selectedCandidate.directLeafPossible) {
        return {
          treeId: String(treeInstanceId),
          treeName,
          placementMode: 'direct_leaf_from_anchor',
          selectedAnchorNodeId: selectedCandidate.nodeId,
          selectedAnchorBreadcrumb: selection.selectedBreadcrumb || selectedCandidate.breadcrumb,
          generatedPathTitles: [],
          plannedLeafParentBreadcrumb: selection.selectedBreadcrumb || selectedCandidate.breadcrumb,
          generatedLeafTitle: selection.generatedLeafTitle,
          originalQuestion: normalizedOriginalQuestion,
          broaderAnswer: normalizedBroaderAnswer,
        };
      }
    }
  }

  if (!Number.isFinite(maxDepth) || maxDepth < 0) {
    throw new Error(`Tree depth is not configured for ${treeName}.`);
  }

  const requiredPathTitleCount = selectedCandidate
    ? selectedCandidate.remainingDepthBudget - 1
    : maxDepth;
  const pathPlan = await generateChatLeafPathPlan({
    treeName,
    originalQuestion: normalizedOriginalQuestion,
    broaderAnswer: normalizedBroaderAnswer,
    anchorBreadcrumbTitles: selectedCandidate?.breadcrumbTitles ?? [],
    requiredPathTitleCount,
  });

  const anchorBreadcrumbTitles = selectedCandidate?.breadcrumbTitles ?? [];
  const plannedLeafParentBreadcrumb = buildResolvedBreadcrumb(anchorBreadcrumbTitles, pathPlan.pathTitles);

  return {
    treeId: String(treeInstanceId),
    treeName,
    placementMode: selectedCandidate ? 'anchor_with_intermediates' : 'full_path_from_root',
    selectedAnchorNodeId: selectedCandidate?.nodeId ?? '',
    selectedAnchorBreadcrumb: selectedCandidate?.breadcrumb ?? '',
    generatedPathTitles: pathPlan.pathTitles,
    plannedLeafParentBreadcrumb,
    generatedLeafTitle: pathPlan.generatedLeafTitle,
    originalQuestion: normalizedOriginalQuestion,
    broaderAnswer: normalizedBroaderAnswer,
  };
}

async function createChatLeafPlacementRecords({
  treeInstanceId,
  selectedAnchorNodeId,
  generatedPathTitles,
  generatedLeafTitle,
  transaction,
}) {
  let currentParentId = selectedAnchorNodeId ? parseInt(selectedAnchorNodeId, 10) : null;
  const createdIntermediateNodes = [];

  for (const title of generatedPathTitles) {
    const createdNode = await createTreeNodeRecord({
      parentId: currentParentId,
      treeInstanceId,
      name: title,
      ensureLeafDetails: false,
      transaction,
    });

    if (createdNode.isLeafNode) {
      throw new Error('The chat add action generated too many intermediate path levels for the target tree.');
    }

    createdIntermediateNodes.push({
      createdNodeId: createdNode.createdNodeId,
      title,
    });
    currentParentId = parseInt(createdNode.createdNodeId, 10);
  }

  const createdLeafNode = await createTreeNodeRecord({
    parentId: currentParentId,
    treeInstanceId,
    name: generatedLeafTitle,
    ensureLeafDetails: true,
    transaction,
  });

  if (!createdLeafNode.isLeafNode) {
    throw new Error('The chat add action must create a leaf node.');
  }

  return {
    createdIntermediateNodes,
    createdLeafNode,
    finalParentNodeId: currentParentId === null ? null : String(currentParentId),
  };
}

async function createTreeNodeRecord({ parentId, treeInstanceId, name, ensureLeafDetails = false, transaction = null }) {
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
      WHERE tree_instance_id = @tree_instance_id AND parent_id IS NULL
    `
    : `
      SELECT ISNULL(MAX(sort_order), -1) + 1 AS nextSortOrder
      FROM tree_nodes
      WHERE tree_instance_id = @tree_instance_id AND parent_id = @parent_id
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
          WHERE tree_instance_id = @tree_instance_id AND id = @parent_id

          UNION ALL

          SELECT parent.id, parent.parent_id, parent.is_leaf_node
          FROM tree_nodes parent
          INNER JOIN Ancestors child ON child.parent_id = parent.id
          WHERE parent.tree_instance_id = @tree_instance_id
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

async function CreateTreeNode({ parentId, treeInstanceId, name, ensureLeafDetails = false }) {
  return withSqlConnection(async () => {
    const createdNode = await createTreeNodeRecord({ parentId, treeInstanceId, name, ensureLeafDetails });

    return {
      createdNodeId: createdNode.createdNodeId,
      flatData: await queryTreeData(treeInstanceId),
    };
  });
}

async function getNodeGenerationContext(treeInstanceId, nodeId, transaction = null) {
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
        WHERE tree_instance_id = @tree_instance_id AND id = @id

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

async function CreateGeneratedChildNodes({ treeInstanceId, parentId, children }) {
  return withSqlConnection(async () => {
    const generationContext = await getNodeGenerationContext(treeInstanceId, parentId);

    if (!generationContext) {
      throw new Error('Node was not found for the selected tree');
    }

    if (generationContext.isLeafNode) {
      throw new Error('Cannot generate child nodes for a leaf node');
    }

    const transaction = new sql.Transaction();
    const createdNodeIds = [];

    try {
      await transaction.begin();

      for (const child of children) {
        const createdNode = await createTreeNodeRecord({
          parentId,
          treeInstanceId,
          name: child.title,
          ensureLeafDetails: true,
          transaction,
        });

        createdNodeIds.push(createdNode.createdNodeId);
      }

      await transaction.commit();
    } catch (error) {
      if (transaction._aborted !== true) {
        await transaction.rollback();
      }

      throw error;
    }

    return {
      createdNodeIds,
      flatData: await queryTreeData(treeInstanceId),
    };
  });
}

async function DeleteTreeNode({ id, treeInstanceId }) {
  return withSqlConnection(async () => {
    const deleteResult = await new sql.Request()
      .input('id', sql.Int, id)
      .input('tree_instance_id', sql.Int, treeInstanceId)
      .query(`
        WITH Descendants AS (
          SELECT id
          FROM tree_nodes
          WHERE id = @id AND tree_instance_id = @tree_instance_id

          UNION ALL

          SELECT child.id
          FROM tree_nodes child
          INNER JOIN Descendants parent_descendant ON child.parent_id = parent_descendant.id
          WHERE child.tree_instance_id = @tree_instance_id
        )
        DELETE tree_nodes
        FROM tree_nodes
        INNER JOIN Descendants ON Descendants.id = tree_nodes.id
        WHERE tree_nodes.tree_instance_id = @tree_instance_id;
      `);

    if (!deleteResult.rowsAffected.some((count) => count > 0)) {
      throw new Error('Node was not found for the selected tree');
    }

    return queryTreeData(treeInstanceId);
  });
}

async function UpdateTreeNodes(treeInstanceId, nodes) {
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

async function UpdateTreeNodeOpenState(treeInstanceId, nodeId, isExpanded) {
  return withSqlConnection(async () => {
    await new sql.Request()
      .input('tree_instance_id', sql.Int, treeInstanceId)
      .input('id', sql.Int, nodeId)
      .input('is_expanded', sql.Bit, isExpanded ? 1 : 0)
      .query(`UPDATE tree_nodes SET is_expanded = @is_expanded WHERE tree_instance_id = @tree_instance_id AND id = @id`);
  });
}

async function UpdateTreeNodeDetails(treeInstanceId, nodeId, { name, notes }) {
  return withSqlConnection(async () => {
    const trimmedName = name.trim();
    const treeNode = await queryTreeNode(treeInstanceId, nodeId);

    if (!treeNode) {
      throw new Error('Node was not found for the selected tree');
    }

    const updateResult = await new sql.Request()
      .input('tree_instance_id', sql.Int, treeInstanceId)
      .input('id', sql.Int, nodeId)
      .input('text', sql.NVarChar, trimmedName)
      .query(`
        UPDATE tree_nodes
        SET text = @text
        WHERE tree_instance_id = @tree_instance_id AND id = @id;
      `);

    if (!updateResult.rowsAffected[0]) {
      throw new Error('Node was not found for the selected tree');
    }

    if (!treeNode.isLeafNode) {
      return {
        flatData: await queryTreeData(treeInstanceId),
        details: {
          id: String(nodeId),
          name: trimmedName,
          notes: '',
          attachments: [],
          isLeafNode: false,
        },
      };
    }

    await new sql.Request()
      .input('tree_node_id', sql.Int, nodeId)
      .input('notes', sql.NVarChar(sql.MAX), notes ?? '')
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

    return {
      flatData: await queryTreeData(treeInstanceId),
      details: await queryNodeDetails(treeInstanceId, nodeId, null, treeNode),
    };
  });
}

async function updateTreeNodeDetailsRecord({ treeInstanceId, nodeId, name, notes, transaction }) {
  const trimmedName = String(name ?? '').trim();

  if (!trimmedName) {
    throw new Error('A non-empty leaf title is required.');
  }

  const treeNode = await queryTreeNode(treeInstanceId, nodeId, transaction);

  if (!treeNode) {
    throw new Error('Node was not found for the selected tree');
  }

  await createSqlRequest(transaction)
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('id', sql.Int, nodeId)
    .input('text', sql.NVarChar, trimmedName)
    .query(`
      UPDATE tree_nodes
      SET text = @text
      WHERE tree_instance_id = @tree_instance_id AND id = @id;
    `);

  if (!treeNode.isLeafNode) {
    throw new Error('Only leaf nodes can be updated through the chat add action.');
  }

  await createSqlRequest(transaction)
    .input('tree_node_id', sql.Int, nodeId)
    .input('notes', sql.NVarChar(sql.MAX), notes ?? '')
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

async function CreateLeafNodeFromChat({
  treeInstanceId,
  toolName,
  originalQuestion,
  broaderAnswer,
  placementMode,
  selectedAnchorNodeId,
  selectedAnchorBreadcrumb,
  generatedPathTitles,
  plannedLeafParentBreadcrumb,
  generatedLeafTitle,
}) {
  const resolvedPlacement = placementMode && generatedLeafTitle
    ? {
      treeId: String(treeInstanceId),
      treeName: (await queryTreeSummary(treeInstanceId)).treeName,
      placementMode: String(placementMode ?? '').trim(),
      selectedAnchorNodeId: String(selectedAnchorNodeId ?? '').trim(),
      selectedAnchorBreadcrumb: String(selectedAnchorBreadcrumb ?? '').trim(),
      generatedPathTitles: Array.isArray(generatedPathTitles)
        ? generatedPathTitles.map((title) => String(title ?? '').trim()).filter(Boolean)
        : [],
      plannedLeafParentBreadcrumb: String(plannedLeafParentBreadcrumb ?? '').trim(),
      generatedLeafTitle: String(generatedLeafTitle ?? '').trim(),
      originalQuestion: String(originalQuestion ?? '').trim(),
      broaderAnswer: String(broaderAnswer ?? '').trim(),
    }
    : await resolveChatLeafPlacement({ treeInstanceId, originalQuestion, broaderAnswer });

  if (!resolvedPlacement.generatedLeafTitle) {
    throw new Error('A generated leaf title is required for the chat add action.');
  }

  const generatedNotes = await generateLeafNotesFromChatAnswer({
    treeName: resolvedPlacement.treeName,
    breadcrumbTitles: [
      ...String(resolvedPlacement.plannedLeafParentBreadcrumb ?? '').split('>').map((title) => title.trim()).filter(Boolean),
      resolvedPlacement.generatedLeafTitle,
    ],
    originalQuestion: resolvedPlacement.originalQuestion,
    broaderAnswer: resolvedPlacement.broaderAnswer,
  });

  return withSqlConnection(async () => {
    const transaction = new sql.Transaction();

    try {
      await transaction.begin();

      const placementResult = await createChatLeafPlacementRecords({
        treeInstanceId,
        selectedAnchorNodeId: resolvedPlacement.selectedAnchorNodeId,
        generatedPathTitles: resolvedPlacement.generatedPathTitles,
        generatedLeafTitle: resolvedPlacement.generatedLeafTitle,
        transaction,
      });

      await updateTreeNodeDetailsRecord({
        treeInstanceId,
        nodeId: parseInt(placementResult.createdLeafNode.createdNodeId, 10),
        name: resolvedPlacement.generatedLeafTitle,
        notes: generatedNotes.notes,
        transaction,
      });

      await transaction.commit();

      return {
        treeId: String(treeInstanceId),
        toolName: String(toolName ?? '').trim(),
        placementMode: resolvedPlacement.placementMode,
        createdNodeId: placementResult.createdLeafNode.createdNodeId,
        selectedAnchorNodeId: resolvedPlacement.selectedAnchorNodeId,
        selectedAnchorBreadcrumb: resolvedPlacement.selectedAnchorBreadcrumb,
        plannedLeafParentBreadcrumb: resolvedPlacement.plannedLeafParentBreadcrumb,
        createdIntermediateNodes: placementResult.createdIntermediateNodes,
        generatedLeafTitle: resolvedPlacement.generatedLeafTitle,
        flatData: await queryTreeData(treeInstanceId),
        details: await queryNodeDetails(treeInstanceId, placementResult.createdLeafNode.createdNodeId),
      };
    } catch (error) {
      if (transaction._aborted !== true) {
        await transaction.rollback();
      }

      throw error;
    }
  });
}

async function ensureTreeNodeDetailsRow(treeNodeId, transaction = null) {
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

async function assertLeafNode(treeInstanceId, nodeId) {
  const node = await queryTreeNode(treeInstanceId, nodeId);

  if (!node) {
    throw new Error('Node was not found for the selected tree');
  }

  if (!node.isLeafNode) {
    throw new Error('Only leaf nodes can have details or attachments');
  }

  return node;
}

function validateAttachmentFile(file) {
  if (!file || typeof file.name !== 'string') {
    throw new Error('Upload request did not include a valid file');
  }

  const normalizedFileName = file.name.toLowerCase();
  const extensionIndex = normalizedFileName.lastIndexOf('.');
  const extension = extensionIndex >= 0 ? normalizedFileName.slice(extensionIndex) : '';

  if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(extension)) {
    throw new Error(`File type is not allowed for uploads: ${file.name}`);
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File exceeds the 10 MB upload limit: ${file.name}`);
  }
}

async function createAttachmentMetadataRecord(treeNodeId, attachment) {
  const insertResult = await new sql.Request()
    .input('tree_node_id', sql.Int, treeNodeId)
    .input('original_file_name', sql.NVarChar(260), attachment.originalFileName)
    .input('content_type', sql.NVarChar(200), attachment.contentType)
    .input('byte_size', sql.BigInt, attachment.byteSize)
    .input('blob_name', sql.NVarChar(1024), attachment.blobName)
    .input('blob_url', sql.NVarChar(2048), attachment.blobUrl)
    .query(`
      INSERT INTO tree_node_detail_files (
        tree_node_id,
        original_file_name,
        content_type,
        byte_size,
        blob_name,
        blob_url
      )
      VALUES (
        @tree_node_id,
        @original_file_name,
        @content_type,
        @byte_size,
        @blob_name,
        @blob_url
      );
    `);

  return insertResult.rowsAffected[0] > 0;
}

async function CreateTreeNodeAttachment({ treeInstanceId, nodeId, files }) {
  return withSqlConnection(async () => {
    await assertLeafNode(treeInstanceId, nodeId);

    await ensureTreeNodeDetailsRow(nodeId);

    const uploadedBlobNames = [];

    try {
      for (const file of files) {
        validateAttachmentFile(file);

        const uploadedFile = await uploadNodeAttachment({
          treeId: treeInstanceId,
          nodeId,
          file,
        });

        uploadedBlobNames.push(uploadedFile.blobName);

        await createAttachmentMetadataRecord(nodeId, {
          originalFileName: file.name,
          contentType: uploadedFile.contentType,
          byteSize: uploadedFile.byteSize,
          blobName: uploadedFile.blobName,
          blobUrl: uploadedFile.blobUrl,
        });
      }
    } catch (error) {
      for (const blobName of uploadedBlobNames) {
        await deleteNodeAttachmentBlobIfExists(blobName);
      }

      throw error;
    }

    return queryNodeDetails(treeInstanceId, nodeId);
  });
}

async function deleteAttachmentMetadataRecord(treeInstanceId, attachmentId) {
  const attachmentResult = await new sql.Request()
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('attachment_id', sql.Int, attachmentId)
    .query(`
      SELECT TOP 1
        CAST(files.tree_node_id AS VARCHAR(10)) AS treeNodeId,
        files.blob_name AS blobName
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      WHERE tn.tree_instance_id = @tree_instance_id AND files.id = @attachment_id;
    `);

  const attachment = attachmentResult.recordset[0] ?? null;
  if (!attachment) {
    throw new Error('Attachment was not found for the selected tree');
  }

  await deleteNodeAttachmentBlobIfExists(attachment.blobName);

  await new sql.Request()
    .input('attachment_id', sql.Int, attachmentId)
    .query('DELETE FROM tree_node_detail_files WHERE id = @attachment_id;');

  return queryNodeDetails(treeInstanceId, attachment.treeNodeId);
}

async function getDescendantAttachmentBlobs(treeInstanceId, nodeId) {
  const result = await new sql.Request()
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('id', sql.Int, nodeId)
    .query(`WITH Descendants AS (
        SELECT id
        FROM tree_nodes
        WHERE id = @id AND tree_instance_id = @tree_instance_id
        UNION ALL
        SELECT t.id
        FROM tree_nodes t
        INNER JOIN Descendants d ON t.parent_id = d.id
        WHERE t.tree_instance_id = @tree_instance_id
      )
      SELECT files.blob_name AS blobName
      FROM Descendants d
      INNER JOIN tree_node_detail_files files ON files.tree_node_id = d.id;
    `);

  return result.recordset;
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
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
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

      return NextResponse.json(await CreateTreeNodeAttachment({
        treeInstanceId: parseInt(String(treeId), 10),
        nodeId: parseInt(String(nodeId), 10),
        files,
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

      return NextResponse.json(await CreateLeafNodeFromChat({
        treeInstanceId: parseInt(resolvedTreeId, 10),
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

      return NextResponse.json(await resolveChatLeafPlacement({
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

      const treeInstanceId = parseInt(String(treeId), 10);
      const selectedNodeId = parseInt(String(nodeId), 10);
      const generationContext = await withSqlConnection(async () => getNodeGenerationContext(treeInstanceId, selectedNodeId));

      if (!generationContext) {
        return NextResponse.json({ error: 'Node was not found for the selected tree' }, { status: 404 });
      }

      if (generationContext.isLeafNode) {
        return NextResponse.json({ error: 'Cannot generate child nodes for a leaf node' }, { status: 400 });
      }

      const generatedChildren = await generateChildTitlesFromBreadcrumb({
        treeName: generationContext.treeName,
        breadcrumbTitles: generationContext.breadcrumbTitles,
        generateLeafChildren: generationContext.generatedChildIsLeaf,
      });

      return NextResponse.json(await CreateGeneratedChildNodes({
        treeInstanceId,
        parentId: selectedNodeId,
        children: generatedChildren.children,
      }));
    }

    if (action === 'generate-notes') {
      if (!nodeId) {
        return NextResponse.json({ error: 'Invalid request, nodeId is required for note generation' }, { status: 400 });
      }

      const treeInstanceId = parseInt(String(treeId), 10);
      const selectedNodeId = parseInt(String(nodeId), 10);
      const generationContext = await withSqlConnection(async () => getNodeGenerationContext(treeInstanceId, selectedNodeId));

      if (!generationContext) {
        return NextResponse.json({ error: 'Node was not found for the selected tree' }, { status: 404 });
      }

      if (!generationContext.isLeafNode) {
        return NextResponse.json({ error: 'Cannot generate notes for a non-leaf node' }, { status: 400 });
      }

      const generatedDraft = await generateLeafNotesDraft({
        treeName: generationContext.treeName,
        breadcrumbTitles: generationContext.breadcrumbTitles,
      });

      return NextResponse.json({
        notes: generatedDraft.notes,
      });
    }

    return NextResponse.json(await CreateTreeNode({
      parentId: parentId === null || parentId === undefined ? null : parseInt(parentId, 10),
      treeInstanceId: parseInt(treeId, 10),
      name: name?.trim() || 'New node',
    }));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
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
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const { id, treeId, isExpanded, name, notes } = await request.json();

    if (id === undefined || !treeId) {
      return NextResponse.json({ error: 'Invalid request, id and treeId are required' }, { status: 400 });
    }

    await assertWritableTreeForRequest(request, treeId);

    if (typeof isExpanded === 'boolean') {
      await UpdateTreeNodeOpenState(parseInt(treeId), id, isExpanded);
      return NextResponse.json({ success: true });
    }

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Invalid request, name is required when saving node details' }, { status: 400 });
    }

    return NextResponse.json(await UpdateTreeNodeDetails(parseInt(treeId), parseInt(id), {
      name,
      notes: typeof notes === 'string' ? notes : '',
    }));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const idParam = searchParams.get('id');
    const treeIdParam = searchParams.get('treeId');
    const attachmentIdParam = searchParams.get('attachmentId');

    if (attachmentIdParam) {
      if (!treeIdParam) {
        return NextResponse.json({ error: 'Invalid request, treeId is required for attachment delete' }, { status: 400 });
      }

      await assertWritableTreeForRequest(request, treeIdParam);

      return NextResponse.json(await withSqlConnection(async () => {
        return deleteAttachmentMetadataRecord(parseInt(treeIdParam, 10), parseInt(attachmentIdParam, 10));
      }));
    }

    if (!idParam || !treeIdParam) {
      return NextResponse.json({ error: 'Invalid request, id and treeId are required' }, { status: 400 });
    }

    await assertWritableTreeForRequest(request, treeIdParam);

    return NextResponse.json(await withSqlConnection(async () => {
      const treeInstanceId = parseInt(treeIdParam, 10);
      const nodeId = parseInt(idParam, 10);
      const attachments = await getDescendantAttachmentBlobs(treeInstanceId, nodeId);

      for (const attachment of attachments) {
        await deleteNodeAttachmentBlobIfExists(attachment.blobName);
      }

      return DeleteTreeNode({ id: nodeId, treeInstanceId });
    }));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

