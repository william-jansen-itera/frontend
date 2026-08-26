import { NextResponse } from 'next/server';
import { generateTreeNodesFromDescription } from '@/server/utils/chatService';
import { parseClientPrincipal } from '@/server/utils/auth';
import { appendGeneratedNodesToTree, assertTreeAccess, getTreeForPopulation, getTreeList } from '@/server/utils/treeCatalog';

function parseTreeId(value) {
  const parsedValue = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsedValue)) {
    return null;
  }

  return parsedValue;
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const parsedTreeId = parseTreeId(payload?.treeId);
    const principal = parseClientPrincipal(request);
    const visibility = String(payload?.visibility ?? '').trim() || 'public';

    if (!parsedTreeId) {
      return NextResponse.json({ error: 'Invalid request, treeId is required' }, { status: 400 });
    }

    await assertTreeAccess(parsedTreeId, {
      principal,
      visibility,
      requireWriteAccess: true,
    });

    const tree = await getTreeForPopulation(parsedTreeId, {
      principal,
      visibility,
      enforceAccess: true,
      requireWriteAccess: true,
    });

    if (!tree.description.trim()) {
      return NextResponse.json({ error: 'A saved description is required before populating a tree' }, { status: 400 });
    }

    const generated = await generateTreeNodesFromDescription(tree);
    const inserted = await appendGeneratedNodesToTree({
      treeId: parsedTreeId,
      generatedNodes: generated.nodes,
    });
    const trees = await getTreeList({ principal, visibility, enforceAccess: true });
    const updatedTree = trees.find((entry) => String(entry.id) === String(parsedTreeId)) ?? tree;

    return NextResponse.json({
      treeId: String(parsedTreeId),
      status: 'success',
      message: `Appended ${inserted.totalNodeCount} nodes across ${inserted.rootNodeCount} root ${inserted.rootNodeCount === 1 ? 'branch' : 'branches'}.`,
      inserted,
      tree: updatedTree,
      trees,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Tree population failed.' },
      { status: 500 },
    );
  }
}