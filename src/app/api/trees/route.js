import { NextResponse } from 'next/server';
import { createTree, deleteTree, getTreeList, updateTreeTitle } from '@/server/utils/treeCatalog';

function parseTreeId(value) {
  const parsedValue = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsedValue)) {
    return null;
  }

  return parsedValue;
}

export async function GET() {
  try {
    return NextResponse.json(await getTreeList());
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { name } = await request.json();

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Invalid request, name is required' }, { status: 400 });
    }

    const createdTree = await createTree({ name });

    return NextResponse.json({
      createdTree,
      trees: await getTreeList(),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const { treeId, name } = await request.json();
    const parsedTreeId = parseTreeId(treeId);

    if (!parsedTreeId || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Invalid request, treeId and name are required' }, { status: 400 });
    }

    const updatedTree = await updateTreeTitle({ treeId: parsedTreeId, name });

    return NextResponse.json({
      updatedTree,
      trees: await getTreeList(),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const parsedTreeId = parseTreeId(searchParams.get('treeId'));

    if (!parsedTreeId) {
      return NextResponse.json({ error: 'Invalid request, treeId is required' }, { status: 400 });
    }

    await deleteTree({ treeId: parsedTreeId });

    return NextResponse.json({
      success: true,
      trees: await getTreeList(),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}