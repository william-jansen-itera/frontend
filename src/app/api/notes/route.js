
import { NextResponse } from 'next/server';
import * as sql from 'mssql';

const config = {
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  applicationIdentifier: process.env.APPLICATION_IDENTIFIER,
  options: {
    encrypt: process.env.AZURE_SQL_ENCRYPT === 'true',
    trustServerCertificate: false,
  },
};

async function withSqlConnection(callback) {
  await sql.connect(config);

  try {
    return await callback();
  } finally {
    await sql.close();
  }
}

function getRequiredApplicationIdentifier() {
  if (!config.applicationIdentifier) {
    throw new Error('Application identifier env var is not configured');
  }

  return config.applicationIdentifier;
}

async function getTreeList() {
  const query = `
    SELECT
      CAST(ti.id AS VARCHAR(10)) AS id,
      COALESCE(NULLIF(ti.display_name, ''), root_node.text, CONCAT('Tree ', ti.id)) AS name
    FROM tree_instance ti
    INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
    OUTER APPLY (
      SELECT TOP 1 tn.text
      FROM tree_nodes tn
      WHERE tn.tree_instance_id = ti.id AND tn.parent_id IS NULL
      ORDER BY tn.sort_order, tn.id
    ) root_node
    WHERE ai.app_identifier = @application_identifier
    ORDER BY COALESCE(NULLIF(ti.display_name, ''), root_node.text, CONCAT('Tree ', ti.id));`;

  return withSqlConnection(async () => {
    const result = await new sql.Request()
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
      .query(query);

    return result.recordset;
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

async function queryNodeDetails(treeInstanceId, nodeId) {
  const detailResult = await new sql.Request()
    .input('tree_instance_id', sql.Int, parseInt(treeInstanceId, 10))
    .input('id', sql.Int, parseInt(nodeId, 10))
    .query(`
      SELECT
        CAST(tn.id AS VARCHAR(10)) AS id,
        tn.text AS name,
        ISNULL(tnd.description, '') AS description,
        ISNULL(tnd.notes, '') AS notes
      FROM tree_nodes tn
      LEFT JOIN tree_node_details tnd ON tnd.tree_node_id = tn.id
      WHERE tn.tree_instance_id = @tree_instance_id AND tn.id = @id;
    `);

  return detailResult.recordset[0] ?? null;
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

async function getTreeCreateContext(treeInstanceId, parentId) {
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

  const result = await new sql.Request()
    .input('tree_instance_id', sql.Int, treeInstanceId)
    .input('parent_id', sql.Int, parentId)
    .query(query);

  return result.recordset[0] ?? null;
}

async function CreateTreeNode({ parentId, treeInstanceId, name }) {
  return withSqlConnection(async () => {
    const createContext = await getTreeCreateContext(treeInstanceId, parentId);
    if (!createContext) {
      throw new Error('Parent node was not found for the selected tree');
    }

    if (createContext.isLeafNode) {
      throw new Error('Cannot add a child node to a leaf node');
    }

    const parentDepth = Number(createContext.parentDepth);
    const maxDepth = Number(createContext.maxDepth);
    const nextDepth = parentDepth + 1;

    if (Number.isFinite(maxDepth) && nextDepth > maxDepth) {
      throw new Error(`Cannot create nodes deeper than nodes.max_depth (${maxDepth})`);
    }

    const isLeafNode = Number.isFinite(maxDepth) && nextDepth >= maxDepth;

    const sortOrderResult = await new sql.Request()
      .input('tree_instance_id', sql.Int, treeInstanceId)
      .input('parent_id', sql.Int, parentId)
      .query(`
        SELECT ISNULL(MAX(sort_order), -1) + 1 AS nextSortOrder
        FROM tree_nodes
        WHERE tree_instance_id = @tree_instance_id AND parent_id = @parent_id
      `);
    const nextSortOrder = sortOrderResult.recordset[0].nextSortOrder;

    const insertResult = await new sql.Request()
      .input('tree_instance_id', sql.Int, treeInstanceId)
      .input('parent_id', sql.Int, parentId)
      .input('text', sql.NVarChar, name)
      .input('is_leaf_node', sql.Bit, isLeafNode ? 1 : 0)
      .input('is_expanded', sql.Bit, 0)
      .input('draggable', sql.Bit, 1)
      .input('sort_order', sql.Int, nextSortOrder)
      .query(`
        INSERT INTO tree_nodes (tree_instance_id, parent_id, text, is_leaf_node, is_expanded, draggable, sort_order)
        OUTPUT INSERTED.id AS createdNodeId
        VALUES (@tree_instance_id, @parent_id, @text, @is_leaf_node, @is_expanded, @draggable, @sort_order)
      `);
    const createdNodeId = insertResult.recordset[0].createdNodeId;

    return {
      createdNodeId: String(createdNodeId),
      flatData: await queryTreeData(treeInstanceId),
    };
  });
}

async function DeleteTreeNode({ id, treeInstanceId }) {
  const deleteQuery = `WITH Descendants AS (
      SELECT id
      FROM tree_nodes
      WHERE id = @id AND tree_instance_id = @tree_instance_id
      UNION ALL
      SELECT t.id
      FROM tree_nodes t
      INNER JOIN Descendants d ON t.parent_id = d.id
      WHERE t.tree_instance_id = @tree_instance_id
    )
    DELETE FROM tree_nodes
    WHERE tree_instance_id = @tree_instance_id
      AND id IN (SELECT id FROM Descendants);`;

  return withSqlConnection(async () => {
    await new sql.Request()
      .input('id', sql.Int, id)
      .input('tree_instance_id', sql.Int, treeInstanceId)
      .query(deleteQuery);

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
        .input('is_expanded', sql.Bit, node.isExpanded ? 1 : 0)
        .query(`
          UPDATE tree_nodes
          SET parent_id = @parent, text = @text, sort_order = @sort_order, is_expanded = @is_expanded
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

async function UpdateTreeNodeDetails(treeInstanceId, nodeId, { name, description, notes }) {
  return withSqlConnection(async () => {
    const trimmedName = name.trim();

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

    await new sql.Request()
      .input('tree_node_id', sql.Int, nodeId)
      .input('description', sql.NVarChar, description ?? '')
      .input('notes', sql.NVarChar(sql.MAX), notes ?? '')
      .query(`
        MERGE tree_node_details AS target
        USING (SELECT @tree_node_id AS tree_node_id) AS source
          ON target.tree_node_id = source.tree_node_id
        WHEN MATCHED THEN
          UPDATE SET
            description = @description,
            notes = @notes,
            updated_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (tree_node_id, description, notes, created_at, updated_at)
          VALUES (@tree_node_id, @description, @notes, SYSUTCDATETIME(), SYSUTCDATETIME());
      `);

    return {
      flatData: await queryTreeData(treeInstanceId),
      details: await queryNodeDetails(treeInstanceId, nodeId),
    };
  });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const treeIdParam = searchParams.get('treeId');
  const includeParam = searchParams.get('include');
  const nodeIdParam = searchParams.get('id');

  try {
    if (!treeIdParam) {
      return NextResponse.json(await getTreeList());
    }

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
    const { parentId, treeId, name } = await request.json();

    if (parentId === undefined || !treeId) {
      return NextResponse.json({ error: 'Invalid request, parentId and treeId are required' }, { status: 400 });
    }

    return NextResponse.json(await CreateTreeNode({
      parentId: parseInt(parentId),
      treeInstanceId: parseInt(treeId),
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

    await UpdateTreeNodes(parseInt(treeId), nodes);
    return NextResponse.json(await getTreeData(treeId));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const { id, treeId, isExpanded, name, description, notes } = await request.json();

    if (id === undefined || !treeId) {
      return NextResponse.json({ error: 'Invalid request, id and treeId are required' }, { status: 400 });
    }

    if (typeof isExpanded === 'boolean') {
      await UpdateTreeNodeOpenState(parseInt(treeId), id, isExpanded);
      return NextResponse.json({ success: true });
    }

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Invalid request, name is required when saving node details' }, { status: 400 });
    }

    return NextResponse.json(await UpdateTreeNodeDetails(parseInt(treeId), parseInt(id), {
      name,
      description: typeof description === 'string' ? description : '',
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

    if (!idParam || !treeIdParam) {
      return NextResponse.json({ error: 'Invalid request, id and treeId are required' }, { status: 400 });
    }

    return NextResponse.json(await DeleteTreeNode({
      id: parseInt(idParam),
      treeInstanceId: parseInt(treeIdParam),
    }));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

