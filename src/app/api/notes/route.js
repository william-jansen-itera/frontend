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

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const idParam = searchParams.get('id');
  let query;
  if (idParam) {
    query = `WITH RecursiveTree AS (
      SELECT id, parent_id as parent, text, droppable
      FROM tree_nodes
      WHERE id = @id
      UNION ALL
      SELECT t.id, t.parent_id as parent, t.text, t.droppable
      FROM tree_nodes t
      INNER JOIN RecursiveTree rt ON t.parent_id = rt.id
    )
    SELECT * FROM RecursiveTree`;
  } else {
    return NextResponse.json({ error: 'Invalid request, id parameter not found' }, { status: 400 });
  }
  try {
    await sql.connect(config);
    let result;
    const request = new sql.Request();
    result = await request.input('id', sql.Int, parseInt(idParam)).query(query);
    return NextResponse.json(result.recordset);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    await sql.close();
  }
}
