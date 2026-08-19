import { NextResponse } from 'next/server';
import { generateTreeDescriptionDraft, publishStoredTreeDescriptions } from '@/server/utils/chatService';
import {
  createTree,
  deleteTree,
  getTreeList,
  updateTreeDescription,
  updateTreeTitle,
} from '@/server/utils/treeCatalog';

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
    const payload = await request.json();
    const action = String(payload?.action ?? '').trim();

    if (action === 'generate-description') {
      const parsedTreeId = parseTreeId(payload?.treeId);

      if (!parsedTreeId) {
        return NextResponse.json({ error: 'Invalid request, treeId is required' }, { status: 400 });
      }

      const result = await generateTreeDescriptionDraft(parsedTreeId);

      return NextResponse.json({
        treeId: String(parsedTreeId),
        generatedDescription: result.generatedDescription,
      });
    }

    if (action === 'save-description') {
      const parsedTreeId = parseTreeId(payload?.treeId);
      const description = String(payload?.description ?? '');

      if (!parsedTreeId || !description.trim()) {
        return NextResponse.json(
          { error: 'Invalid request, treeId and description are required' },
          { status: 400 },
        );
      }

      const updatedTree = await updateTreeDescription({ treeId: parsedTreeId, description });

      try {
        const syncResult = await publishStoredTreeDescriptions();
        const trees = await getTreeList();
        const syncedTree = trees.find((tree) => String(tree.id) === String(parsedTreeId)) ?? updatedTree;

        return NextResponse.json({
          updatedTree: syncedTree,
          trees,
          saveStatus: {
            status: 'success',
            message: 'Description was saved.',
          },
          syncStatus: {
            status: 'success',
            message: 'Stored descriptions were published to the agent.',
            mode: syncResult.syncMode,
            excludedTreeCount: Array.isArray(syncResult.excludedTrees) ? syncResult.excludedTrees.length : 0,
            excludedTrees: Array.isArray(syncResult.excludedTrees) ? syncResult.excludedTrees : [],
            agent: {
              id: syncResult.agent.id,
              name: syncResult.agent.name,
              version: syncResult.agent.version ?? null,
            },
          },
        });
      } catch (error) {
        const trees = await getTreeList();

        return NextResponse.json({
          updatedTree,
          trees,
          saveStatus: {
            status: 'success',
            message: 'Description was saved.',
          },
          syncStatus: {
            status: 'failed',
            message: error instanceof Error ? error.message : 'Stored-description sync failed.',
            code: error?.code ?? null,
            missingTrees: Array.isArray(error?.missingTrees) ? error.missingTrees : [],
          },
        }, { status: 207 });
      }
    }

    const { name } = payload;

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

    try {
      const syncResult = await publishStoredTreeDescriptions();

      return NextResponse.json({
        success: true,
        trees: await getTreeList(),
        syncStatus: {
          status: 'success',
          message: 'Stored descriptions were published to the agent.',
          mode: syncResult.syncMode,
          excludedTreeCount: Array.isArray(syncResult.excludedTrees) ? syncResult.excludedTrees.length : 0,
          excludedTrees: Array.isArray(syncResult.excludedTrees) ? syncResult.excludedTrees : [],
          agent: {
            id: syncResult.agent.id,
            name: syncResult.agent.name,
            version: syncResult.agent.version ?? null,
          },
        },
      });
    } catch (error) {
      return NextResponse.json({
        success: true,
        trees: await getTreeList(),
        syncStatus: {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Stored-description sync failed after tree deletion.',
          code: error?.code ?? null,
          missingTrees: Array.isArray(error?.missingTrees) ? error.missingTrees : [],
        },
      });
    }
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}