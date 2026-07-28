
import { NextResponse } from 'next/server';
import * as sql from 'mssql';

const config = {
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  options: {
    encrypt: process.env.AZURE_SQL_ENCRYPT === 'true',
    trustServerCertificate: false,
  },
};


// export async function POST(request) {
//   // Receive the whole tree in the request body
//   try {
//     const tree = await request.json();
//     // Example: Insert all nodes (replace with your logic)
//     await sql.connect(config);
//     for (const node of tree) {
//       await new sql.Request()
//         .input('id', sql.Int, node.id)
//         .input('parent', sql.Int, node.parent)
//         .input('text', sql.NVarChar, node.text)
//         .input('is_leaf_node', sql.Bit, node.isLeafNode ? 1 : 0)
//         .query(`INSERT INTO tree_nodes (id, parent_id, text, is_leaf_node) VALUES (@id, @parent, @text, @is_leaf_node)`);
//     }
//     return NextResponse.json({ success: true });
// } catch (err) {
//     return NextResponse.json({ error: err.message }, { status: 500 });
//   } finally {
//     await sql.close();
//   }
// }

async function getTreeData(rootId) {
  const query = `WITH RecursiveTree AS (
      SELECT 
        CAST(id AS VARCHAR(10)) as id, 
        CAST(parent_id AS VARCHAR(10)) parent, 
        text as name, 
        is_leaf_node AS isLeafNode,
        is_expanded AS isExpanded,
        draggable,
        sort_order,
        CAST(sort_order AS VARCHAR(MAX)) AS path,
        0 AS _depth
      FROM tree_nodes
      WHERE id = @id
      UNION ALL
      SELECT 
        CAST(t.id AS VARCHAR(10)) as id, 
        CAST(t.parent_id AS VARCHAR(10)) parent, 
        t.text as name, 
        t.is_leaf_node AS isLeafNode,
        t.is_expanded AS isExpanded,
        t.draggable,
        t.sort_order,
        rt.path + '-' + CAST(t.sort_order AS VARCHAR(MAX)) AS path,
        rt._depth + 1 AS _depth
      FROM tree_nodes t
      INNER JOIN RecursiveTree rt ON t.parent_id = rt.id      
    )
    SELECT * FROM RecursiveTree
    ORDER BY path;`;
  try {
    await sql.connect(config);
    let result;
    const request = new sql.Request();
    result = await request.input('id', sql.Int, parseInt(rootId)).query(query);
    return result.recordset;
  } catch (err) {
    throw err;
  } finally {
    await sql.close();
  }
}

async function UpdateTreeNodes(nodes) {
  try {
    await sql.connect(config);
    for (const node of nodes) {
      await new sql.Request()
        .input('id', sql.Int, node.id)
        .input('parent', sql.Int, node.parent)
        .input('text', sql.NVarChar, node.name)
        .input('sort_order', sql.Int, node.sort_order)
        .input('is_expanded', sql.Bit, node.isExpanded ? 1 : 0)
        .query(`UPDATE tree_nodes SET parent_id = @parent, text = @text, sort_order = @sort_order, is_expanded = @is_expanded WHERE id = @id`);
    }
  } catch (err) {
    throw err;
  } finally {
    await sql.close();
  }
}

async function UpdateTreeNodeOpenState(nodeId, isExpanded) {
  try {
    await sql.connect(config);
    await new sql.Request()
      .input('id', sql.Int, nodeId)
      .input('is_expanded', sql.Bit, isExpanded ? 1 : 0)
      .query(`UPDATE tree_nodes SET is_expanded = @is_expanded WHERE id = @id`);
  } catch (err) {
    throw err;
  } finally {
    await sql.close();
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const idParam = searchParams.get('id');
  if (!idParam) {
    return NextResponse.json({ error: 'Invalid request, id parameter not found' }, { status: 400 });
  }
  try {
    return NextResponse.json(await getTreeData(idParam));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}


export async function PUT(request) {
  // Receive the whole tree in the request body
  try {
    const tree = await request.json();
    await UpdateTreeNodes(tree);
    const idParam = tree.length > 0 ? tree[0].id : 0;
    return NextResponse.json(await getTreeData(idParam));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    await sql.close();
  }
}

export async function PATCH(request) {
  try {
    const { id, isExpanded } = await request.json();

    if (id === undefined || typeof isExpanded !== 'boolean') {
      return NextResponse.json({ error: 'Invalid request, id and isExpanded are required' }, { status: 400 });
    }

    await UpdateTreeNodeOpenState(id, isExpanded);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}


// export async function DELETE(request) {
//   // Receive the whole tree in the request body
//   try {
//     const tree = await request.json();
//     await sql.connect(config);
//     for (const node of tree) {
//       await new sql.Request()
//         .input('id', sql.Int, node.id)
//         .query(`DELETE FROM tree_nodes WHERE id = @id`);
//     }
//     return NextResponse.json({ success: true });
// } catch (err) {
//     return NextResponse.json({ error: err.message }, { status: 500 });
//   } finally {
//     await sql.close();
//   }
// }