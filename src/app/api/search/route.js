import { NextResponse } from 'next/server';
import { DEFAULT_SEARCH_PAGE_TOP, searchTreeContent } from '@/server/utils/azureSearch';
import { getAllowedTreeIds } from '@/server/utils/treeCatalog';

function parseBooleanSetting(value, fallbackValue) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(normalizedValue)) {
      return true;
    }

    if (['false', '0', 'no', 'off'].includes(normalizedValue)) {
      return false;
    }
  }

  return fallbackValue;
}

function getDefaultIncludeDebug() {
  return parseBooleanSetting(process.env.APPLICATION_DEBUG, false);
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') ?? '';
  const treeId = searchParams.get('treeId') ?? '';
  const top = searchParams.get('top') ?? undefined;
  const includeDebug = getDefaultIncludeDebug();

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
      includeExecutedSearches: includeDebug,
      searchMode: 'any',
    });

    if (!includeDebug) {
      const { executedSearches: _executedSearches, tokenCoverageFilter: _tokenCoverageFilter, ...publicResult } = result;

      return NextResponse.json(publicResult);
    }

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