import { NextResponse } from 'next/server';
import { requireAuthenticatedPrincipal } from '@/server/utils/auth';
import {
  ensurePersonalCacheLeafPath,
  findPersonalCacheLeafPathNode,
} from '@/server/utils/agent/personalCacheTreeRepository';
import { ensurePersonalCacheTree, getAuditMetadata } from '@/server/utils/tree/treeCatalog';
import { updateTreeNodeDetails } from '@/server/utils/tree/treeMutationService';
import { getNodeDetails } from '@/server/utils/tree/treeRecordRepository';

const LANGUAGE_PATH = ['Settings', 'Preferences', 'Application', 'Language'];

function errorResponse(error) {
  return NextResponse.json({ error: error.message }, { status: error.status ?? 500 });
}

export async function GET(request) {
  try {
    const principal = requireAuthenticatedPrincipal(request);
    const tree = await ensurePersonalCacheTree(principal);
    const node = await findPersonalCacheLeafPathNode({ treeId: tree.id, pathSegments: LANGUAGE_PATH });
    if (!node) {
      return NextResponse.json({ language: null });
    }

    const details = await getNodeDetails(tree.id, node.id);
    let language = null;
    try {
      const savedLanguage = JSON.parse(details?.notes ?? '');
      if (savedLanguage?.language === 'en' || savedLanguage?.language === 'da') {
        language = savedLanguage.language;
      }
    } catch {
      // An empty or unrelated note is not a saved language preference.
    }

    return NextResponse.json({ language });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request) {
  try {
    const principal = requireAuthenticatedPrincipal(request);
    const { language } = await request.json();
    if (language !== 'en' && language !== 'da') {
      return NextResponse.json({ error: 'Invalid language' }, { status: 400 });
    }

    const tree = await ensurePersonalCacheTree(principal);
    const node = await ensurePersonalCacheLeafPath({ treeId: tree.id, pathSegments: LANGUAGE_PATH });
    await updateTreeNodeDetails(tree.id, node.id, {
      name: 'Language',
      notes: JSON.stringify({ language }),
      updatedBy: getAuditMetadata(principal),
    });

    return NextResponse.json({ language });
  } catch (error) {
    return errorResponse(error);
  }
}