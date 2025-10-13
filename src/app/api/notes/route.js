import { NextResponse } from 'next/server';
import sql from 'mssql';

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
    query = `SELECT id, parent_id as parent, text, droppable FROM tree_nodes WHERE id = @id`;
  } else {
    return NextResponse.json({ error: 'Invalid request, id parameter not found' }, { status: 400 });
  }
  try {
    await sql.connect(config);
    let result;
    if (idParam) {
      result = await sql.request().input('id', sql.Int, parseInt(idParam)).query(query);
    } else {
      result = await sql.query(query);
    }
    return NextResponse.json(result.recordset);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    await sql.close();
  }
}
