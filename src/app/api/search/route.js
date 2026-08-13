import { NextResponse } from 'next/server';
import { DEFAULT_SEARCH_PAGE_TOP, searchTreeContent } from '@/server/utils/azureSearch';
import { getAllowedTreeIds } from '@/server/utils/treeCatalog';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') ?? '';
  const treeId = searchParams.get('treeId') ?? '';
  const top = searchParams.get('top') ?? undefined;

  if (!query.trim()) {
    return NextResponse.json({
      count: 0,
      results: [],
    });
  }

  try {
    const allowedTreeIds = await getAllowedTreeIds();

    if (allowedTreeIds.length === 0) {
      return NextResponse.json({
        count: 0,
        results: [],
      });
    }

    const result = await searchTreeContent({
      searchText: query,
      treeId,
      top,
      allowedTreeIds,
      defaultTop: DEFAULT_SEARCH_PAGE_TOP,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Search API error:', error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Search request failed',
      },
      { status: 500 },
    );
  }
}