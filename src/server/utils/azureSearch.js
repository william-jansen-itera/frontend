const searchEndpoint = process.env.AZURE_SEARCH_ENDPOINT;
const searchIndexName = process.env.AZURE_SEARCH_INDEX_NAME;
const searchQueryKey = process.env.AZURE_SEARCH_QUERY_KEY || process.env.AZURE_SEARCH_ADMIN_KEY;
const searchAdminKey = process.env.AZURE_SEARCH_ADMIN_KEY;
const searchSqlIndexerName = process.env.AZURE_SEARCH_SQL_INDEXER_NAME || 'tree-sql-indexer';
const searchBlobIndexerName = process.env.AZURE_SEARCH_BLOB_INDEXER_NAME || 'tree-blob-indexer';
const applicationIdentifier = process.env.APPLICATION_IDENTIFIER;
const SEARCH_API_VERSION = '2024-07-01';
const DEFAULT_SEARCH_PAGE_TOP = 25;
const DEFAULT_TOOL_TOP = 5;
const MAX_TOP = 25;
const ENABLE_SEARCH_TOKEN_COVERAGE_FILTER = true;
const SEARCH_TOKEN_COVERAGE_THRESHOLD = 0.5;
const NODE_SCORING_PROFILE = 'node-content-priority';
const NODE_SEARCH_FIELDS = ['content', 'title', 'breadcrumb'];
const ATTACHMENT_SEARCH_FIELDS = ['content', 'ocrText', 'imageDescriptionFiltered', 'attachmentFileName'];
const TOKEN_COVERAGE_FIELDS = [
  'title',
  'nodeText',
  'notes',
  'breadcrumb',
  'content',
  'ocrText',
  'imageDescriptionFiltered',
  'attachmentFileName',
];
const HIGHLIGHT_PRE_TAG = '[[H]]';
const HIGHLIGHT_POST_TAG = '[[/H]]';
const SEARCH_SELECT_FIELDS = [
  'id',
  'sourceType',
  'appIdentifier',
  'appDisplayName',
  'treeId',
  'treeKey',
  'treeDisplayName',
  'nodeId',
  'parentNodeId',
  'title',
  'nodeText',
  'notes',
  'breadcrumb',
  'nodeIdPath',
  'content',
  'ocrText',
  'imageDescription',
  'imageDescriptionConfidence',
  'imageDescriptionFiltered',
  'isLeafNode',
  'depth',
  'sortPath',
  'attachmentFileName',
  'blobName',
  'blobUrl',
  'updatedAt',
  'createdAt',
];

function getRequiredSearchConfig() {
  if (!searchEndpoint) {
    throw new Error('Azure Search endpoint env var is not configured');
  }

  if (!searchIndexName) {
    throw new Error('Azure Search index name env var is not configured');
  }

  if (!searchQueryKey) {
    throw new Error('Azure Search query key env var is not configured');
  }

  return {
    endpoint: searchEndpoint.replace(/\/$/, ''),
    indexName: searchIndexName,
    queryKey: searchQueryKey,
  };
}

function getSearchIndexerConfig(indexerName) {
  if (!searchEndpoint) {
    return { isConfigured: false, reason: 'Azure Search endpoint env var is not configured' };
  }

  if (!searchAdminKey) {
    return { isConfigured: false, reason: 'Azure Search admin key env var is not configured' };
  }

  if (!indexerName) {
    return { isConfigured: false, reason: 'Azure Search indexer name env var is not configured' };
  }

  return {
    isConfigured: true,
    endpoint: searchEndpoint.replace(/\/$/, ''),
    adminKey: searchAdminKey,
    indexerName,
  };
}

function getRequiredSearchWriteConfig() {
  if (!searchEndpoint) {
    throw new Error('Azure Search endpoint env var is not configured');
  }

  if (!searchIndexName) {
    throw new Error('Azure Search index name env var is not configured');
  }

  if (!searchAdminKey) {
    throw new Error('Azure Search admin key env var is not configured');
  }

  return {
    endpoint: searchEndpoint.replace(/\/$/, ''),
    indexName: searchIndexName,
    adminKey: searchAdminKey,
  };
}

function encodeSearchKey(value) {
  const normalizedValue = String(value ?? '');

  if (!normalizedValue) {
    return '';
  }

  // Azure AI Search blob indexers use the default base64Encode mapping,
  // which follows ASP.NET UrlTokenEncode semantics rather than plain
  // base64url. The final character stores how many '=' padding characters
  // were removed, so direct delete operations must generate the same key.
  const base64Value = Buffer.from(normalizedValue, 'utf8').toString('base64');
  let endPosition = base64Value.length;

  while (endPosition > 0 && base64Value[endPosition - 1] === '=') {
    endPosition -= 1;
  }

  const encodedCharacters = new Array(endPosition + 1);
  encodedCharacters[endPosition] = String(base64Value.length - endPosition);

  for (let index = 0; index < endPosition; index += 1) {
    const currentCharacter = base64Value[index];

    if (currentCharacter === '+') {
      encodedCharacters[index] = '-';
    } else if (currentCharacter === '/') {
      encodedCharacters[index] = '_';
    } else {
      encodedCharacters[index] = currentCharacter;
    }
  }

  return encodedCharacters.join('');
}

function chunkValues(values, chunkSize) {
  const chunks = [];

  for (let startIndex = 0; startIndex < values.length; startIndex += chunkSize) {
    chunks.push(values.slice(startIndex, startIndex + chunkSize));
  }

  return chunks;
}

export function buildTreeNodeSearchDocumentId(treeId, nodeId) {
  return `node-${treeId}-${nodeId}`;
}

export function buildAttachmentSearchDocumentId(blobUrl) {
  const normalizedBlobUrl = String(blobUrl ?? '').trim();

  if (!normalizedBlobUrl) {
    return null;
  }

  return encodeSearchKey(normalizedBlobUrl);
}

export async function deleteSearchDocumentsById(documentIds) {
  const normalizedIds = Array.from(new Set(
    (Array.isArray(documentIds) ? documentIds : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  ));

  if (normalizedIds.length === 0) {
    return {
      deletedDocumentCount: 0,
      batchCount: 0,
    };
  }

  const config = getRequiredSearchWriteConfig();
  const batches = chunkValues(normalizedIds, 500);
  const failures = [];

  for (const batch of batches) {
    const response = await fetch(
      `${config.endpoint}/indexes/${encodeURIComponent(config.indexName)}/docs/index?api-version=${SEARCH_API_VERSION}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': config.adminKey,
        },
        body: JSON.stringify({
          value: batch.map((id) => ({
            '@search.action': 'delete',
            id,
          })),
        }),
        cache: 'no-store',
      },
    );

    if (!response.ok) {
      const errorText = (await response.text()).trim();
      throw new Error(`Azure Search document delete failed (${response.status}): ${errorText || 'No error details were returned.'}`);
    }

    const payload = await response.json();
    const results = Array.isArray(payload.value) ? payload.value : [];

    results.forEach((result) => {
      const succeeded = result?.status !== false && Number(result?.statusCode ?? 200) < 400;

      if (!succeeded) {
        failures.push({
          key: String(result?.key ?? ''),
          statusCode: Number(result?.statusCode ?? 0),
          errorMessage: String(result?.errorMessage ?? '').trim(),
        });
      }
    });
  }

  if (failures.length > 0) {
    const summary = failures
      .slice(0, 5)
      .map((failure) => `${failure.key || '<unknown>'} (${failure.statusCode || 'unknown'}${failure.errorMessage ? `: ${failure.errorMessage}` : ''})`)
      .join(', ');
    throw new Error(`Azure Search rejected ${failures.length} purge document delete operation(s): ${summary}`);
  }

  return {
    deletedDocumentCount: normalizedIds.length,
    batchCount: batches.length,
  };
}

async function requestSearchIndexerOperation(indexerName, operationName) {
  const config = getSearchIndexerConfig(indexerName);

  if (!config.isConfigured) {
    return {
      status: 'skipped',
      reason: config.reason,
    };
  }

  const response = await fetch(
    `${config.endpoint}/indexers/${encodeURIComponent(config.indexerName)}/${operationName}?api-version=${SEARCH_API_VERSION}`,
    {
      method: 'POST',
      headers: {
        'api-key': config.adminKey,
      },
      cache: 'no-store',
    },
  );

  if (response.ok) {
    return {
      status: 'requested',
      operation: operationName,
      indexerName: config.indexerName,
    };
  }

  const errorText = (await response.text()).trim();

  if (response.status === 409) {
    return {
      status: 'already-running',
      operation: operationName,
      indexerName: config.indexerName,
      message: errorText || 'Azure Search reported that the indexer is already running.',
    };
  }

  throw new Error(`Azure Search indexer ${operationName} failed (${response.status}): ${errorText || 'No error details were returned.'}`);
}

export async function requestSearchIndexerRun(indexerName) {
  return requestSearchIndexerOperation(indexerName, 'run');
}

export async function requestSearchIndexerReset(indexerName) {
  return requestSearchIndexerOperation(indexerName, 'reset');
}

export async function requestTreeSqlIndexerRun() {
  return requestSearchIndexerRun(searchSqlIndexerName);
}

export async function requestTreeBlobIndexerRun() {
  return requestSearchIndexerRun(searchBlobIndexerName);
}

function escapeODataString(value) {
  return String(value).replace(/'/g, "''");
}

function buildAllowedTreeFilter(treeId, allowedTreeIds) {
  const normalizedAllowedTreeIds = Array.isArray(allowedTreeIds)
    ? allowedTreeIds.map((value) => String(value)).filter(Boolean)
    : [];

  if (normalizedAllowedTreeIds.length === 0) {
    return "treeId eq '__no_tree_access__'";
  }

  if (treeId) {
    const normalizedTreeId = String(treeId);

    if (!normalizedAllowedTreeIds.includes(normalizedTreeId)) {
      return "treeId eq '__no_tree_access__'";
    }

    return `treeId eq '${escapeODataString(normalizedTreeId)}'`;
  }

  return `search.in(treeId, '${normalizedAllowedTreeIds.map(escapeODataString).join(',')}', ',')`;
}

function buildFilter({ treeId, allowedTreeIds }) {
  const clauses = [buildAllowedTreeFilter(treeId, allowedTreeIds)];

  if (applicationIdentifier) {
    clauses.push(`appIdentifier eq '${escapeODataString(applicationIdentifier)}'`);
  }

  return clauses.join(' and ');
}

function normalizeTop(value, fallbackTop) {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackTop;
  }

  return Math.min(parsedValue, MAX_TOP);
}

function buildSummaryText(value, maxLength = 220) {
  const normalizedText = String(value ?? '').replace(/\s+/g, ' ').trim();

  if (!normalizedText) {
    return null;
  }

  if (normalizedText.length <= maxLength) {
    return normalizedText;
  }

  return `${normalizedText.slice(0, maxLength - 3)}...`;
}

function normalizeSearchDocument(document) {
  return {
    ...document,
    score: document['@search.score'] ?? null,
    highlights: document['@search.highlights'] ?? null,
  };
}

function addAttachmentMatchSource(documents, matchSource) {
  return documents.map((document) => ({
    ...document,
    attachmentMatchSource: matchSource,
  }));
}

function getFirstHighlightValue(highlights, fieldNames) {
  const normalizedHighlights = highlights && typeof highlights === 'object' ? highlights : null;

  if (!normalizedHighlights) {
    return null;
  }

  for (const fieldName of fieldNames) {
    const snippets = Array.isArray(normalizedHighlights[fieldName])
      ? normalizedHighlights[fieldName].map((value) => String(value ?? '').trim()).filter(Boolean)
      : [];

    if (snippets.length > 0) {
      return snippets[0];
    }
  }

  return null;
}

function buildHighlightSnippet(highlights, fieldNames, fallbackText) {
  const highlightValue = getFirstHighlightValue(highlights, fieldNames);

  if (highlightValue) {
    return buildSummaryText(highlightValue);
  }

  return buildSummaryText(fallbackText);
}

function getSearchTokens(value) {
  return String(value ?? '')
    .split(/[^a-zA-Z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function getDistinctSearchTokens(value) {
  return Array.from(new Set(getSearchTokens(value).map((token) => token.toLowerCase())));
}

function addDocumentFieldTokens(tokenSet, fieldValue) {
  if (Array.isArray(fieldValue)) {
    fieldValue.forEach((value) => addDocumentFieldTokens(tokenSet, value));
    return;
  }

  getSearchTokens(fieldValue).forEach((token) => {
    tokenSet.add(token.toLowerCase());
  });
}

function buildGroupDocumentTokenSet(group) {
  const tokenSet = new Set();
  const seenDocuments = new Set();
  const documents = [
    group?.nodeDocument,
    group?.primaryDocument,
    ...(Array.isArray(group?.documents) ? group.documents : []),
    ...(Array.isArray(group?.attachmentDocuments) ? group.attachmentDocuments : []),
  ].filter(Boolean);

  documents.forEach((document) => {
    if (seenDocuments.has(document)) {
      return;
    }

    seenDocuments.add(document);

    TOKEN_COVERAGE_FIELDS.forEach((fieldName) => {
      addDocumentFieldTokens(tokenSet, document?.[fieldName]);
    });
  });

  return tokenSet;
}

function getMinimumMatchedTokenCount(queryTokenCount) {
  if (queryTokenCount <= 1) {
    return 1;
  }

  if (queryTokenCount === 2) {
    return 2;
  }

  return Math.min(3, Math.max(1, Math.ceil(queryTokenCount * SEARCH_TOKEN_COVERAGE_THRESHOLD)));
}

function buildResultTokenCoverage(result, queryTokens) {
  const documentTokens = buildGroupDocumentTokenSet(result);
  const matchedTokens = queryTokens.filter((token) => documentTokens.has(token));
  const minimumMatchedTokenCount = getMinimumMatchedTokenCount(queryTokens.length);

  return {
    matchedTokens,
    matchedTokenCount: matchedTokens.length,
    totalTokenCount: queryTokens.length,
    minimumMatchedTokenCount,
    ratio: queryTokens.length > 0 ? matchedTokens.length / queryTokens.length : 1,
    passes: matchedTokens.length >= minimumMatchedTokenCount,
  };
}

function getBestTokenCoverageResult(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  return results.reduce((bestResult, currentResult) => {
    if (!bestResult) {
      return currentResult;
    }

    const bestCoverage = bestResult?.queryTokenCoverage;
    const currentCoverage = currentResult?.queryTokenCoverage;
    const bestMatchedTokenCount = Number(bestCoverage?.matchedTokenCount ?? -1);
    const currentMatchedTokenCount = Number(currentCoverage?.matchedTokenCount ?? -1);

    if (currentMatchedTokenCount !== bestMatchedTokenCount) {
      return currentMatchedTokenCount > bestMatchedTokenCount ? currentResult : bestResult;
    }

    const bestRatio = Number(bestCoverage?.ratio ?? -1);
    const currentRatio = Number(currentCoverage?.ratio ?? -1);

    if (currentRatio !== bestRatio) {
      return currentRatio > bestRatio ? currentResult : bestResult;
    }

    const bestScore = Number(bestResult?.score ?? -Infinity);
    const currentScore = Number(currentResult?.score ?? -Infinity);

    return currentScore > bestScore ? currentResult : bestResult;
  }, null);
}

function applyTokenCoverageFilter(results, searchText) {
  const queryTokens = getDistinctSearchTokens(searchText);

  if (!ENABLE_SEARCH_TOKEN_COVERAGE_FILTER || queryTokens.length === 0) {
    return {
      results,
      tokenCoverageFilter: {
        enabled: ENABLE_SEARCH_TOKEN_COVERAGE_FILTER,
        threshold: SEARCH_TOKEN_COVERAGE_THRESHOLD,
        policy: '1-of-1, 2-of-2, otherwise min(3, ceil(50% of query tokens))',
        queryTokens,
        tokenCoverage: null,
        resultCountBefore: Array.isArray(results) ? results.length : 0,
        resultCountAfter: Array.isArray(results) ? results.length : 0,
      },
    };
  }

  const evaluatedResults = results.map((result) => {
    return {
      ...result,
      queryTokenCoverage: buildResultTokenCoverage(result, queryTokens),
    };
  });
  const bestTokenCoverageResult = getBestTokenCoverageResult(evaluatedResults);
  const filteredResults = evaluatedResults.filter((result) => result.queryTokenCoverage?.passes);

  return {
    results: filteredResults,
    tokenCoverageFilter: {
      enabled: true,
      threshold: SEARCH_TOKEN_COVERAGE_THRESHOLD,
      policy: '1-of-1, 2-of-2, otherwise min(3, ceil(50% of query tokens))',
      queryTokens,
      tokenCoverage: bestTokenCoverageResult?.queryTokenCoverage ?? null,
      minimumMatchedTokenCount: getMinimumMatchedTokenCount(queryTokens.length),
      resultCountBefore: evaluatedResults.length,
      resultCountAfter: filteredResults.length,
    },
  };
}

function escapeLuceneRegexValue(value) {
  return String(value ?? '').replace(/[\\/.*+?^${}()|[\]{}-]/g, '\\$&');
}

function buildAttachmentFileNameRegexQuery(searchText) {
  const tokens = getSearchTokens(searchText);

  if (tokens.length === 0) {
    return null;
  }

  return tokens
    .map((token) => `attachmentFileName:/.*${escapeLuceneRegexValue(token)}.*/`)
    .join(' AND ');
}

function mergeSearchDocuments(...documentGroups) {
  const documentsById = new Map();

  documentGroups.forEach((documents) => {
    documents.forEach((document) => {
      if (!document?.id || documentsById.has(document.id)) {
        return;
      }

      documentsById.set(document.id, document);
    });
  });

  return Array.from(documentsById.values());
}

function buildNodeHighlightInfo(document) {
  if (!document) {
    return { text: null, source: null };
  }

  const sourceByField = [
    { fieldName: 'content', source: 'notes' },
    { fieldName: 'title', source: 'title' },
    { fieldName: 'breadcrumb', source: 'path' },
  ];

  for (const { fieldName, source } of sourceByField) {
    const snippet = buildHighlightSnippet(document.highlights, [fieldName], null);

    if (snippet) {
      return { text: snippet, source };
    }
  }

  return { text: null, source: null };
}

function buildAttachmentHighlightInfo(document) {
  if (!document) {
    return { text: null, source: null };
  }

  const sourceByField = [
    { fieldName: 'content', source: 'content' },
    { fieldName: 'ocrText', source: 'ocrText' },
    { fieldName: 'imageDescriptionFiltered', source: 'imageDescription' },
    { fieldName: 'attachmentFileName', source: 'fileName' },
  ];

  for (const { fieldName, source } of sourceByField) {
    const snippet = buildHighlightSnippet(document.highlights, [fieldName], null);

    if (snippet) {
      return { text: snippet, source };
    }
  }

  return { text: null, source: document.attachmentMatchSource || null };
}

function buildDebugSearchHitSnapshot(document) {
  if (!document || typeof document !== 'object') {
    return null;
  }

  const {
    '@search.score': _rawSearchScore,
    '@search.highlights': _rawSearchHighlights,
    ...debugDocument
  } = document;

  return {
    ...debugDocument,
  };
}

function buildDebugSearchExecution({
  kind,
  query,
  top,
  filter,
  searchFields,
  scoringProfile = null,
  queryType = null,
  searchMode = null,
  results,
}) {
  return {
    kind,
    query,
    top,
    filter,
    searchFields,
    scoringProfile,
    queryType,
    searchMode,
    resultCount: Array.isArray(results) ? results.length : 0,
    results: Array.isArray(results)
      ? results.map((document) => buildDebugSearchHitSnapshot(document)).filter(Boolean)
      : [],
  };
}

async function executeSearchQuery({
  endpoint,
  indexName,
  queryKey,
  searchText,
  filter,
  top,
  searchFields,
  scoringProfile = null,
  queryType = null,
  searchMode = 'all',
}) {
  const response = await fetch(
    `${endpoint}/indexes/${encodeURIComponent(indexName)}/docs/search?api-version=${SEARCH_API_VERSION}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': queryKey,
      },
      body: JSON.stringify({
        search: searchText,
        top,
        searchMode,
        filter,
        searchFields: searchFields.join(','),
        ...(queryType ? { queryType } : {}),
        ...(scoringProfile ? { scoringProfile } : {}),
        highlight: searchFields.join(','),
        highlightPreTag: HIGHLIGHT_PRE_TAG,
        highlightPostTag: HIGHLIGHT_POST_TAG,
        select: SEARCH_SELECT_FIELDS.join(','),
      }),
      cache: 'no-store',
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Azure Search query failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();

  return Array.isArray(payload.value)
    ? payload.value.map(normalizeSearchDocument)
    : [];
}

function filterDeepestResults(results) {
  return results.filter((result, _, allResults) => {
    if (result.sourceType !== 'node' || !result.sortPath || !result.treeId) {
      return true;
    }

    const resultSortPathPrefix = `${result.sortPath}-`;

    return !allResults.some((candidate) => {
      if (candidate === result) {
        return false;
      }

      if (String(candidate.treeId) !== String(result.treeId)) {
        return false;
      }

      if (!candidate.sortPath || String(candidate.nodeId) === String(result.nodeId)) {
        return false;
      }

      return String(candidate.sortPath).startsWith(resultSortPathPrefix);
    });
  });
}

function groupResultsByNode(results) {
  const groupedResults = new Map();

  results.forEach((result) => {
    const groupKey = `${result.treeId}::${result.nodeId}`;
    const existingGroup = groupedResults.get(groupKey);

    if (!existingGroup) {
      const isNodeDocument = result.sourceType === 'node';

      groupedResults.set(groupKey, {
        id: groupKey,
        treeId: result.treeId,
        nodeId: result.nodeId,
        parentNodeId: result.parentNodeId ?? null,
        score: result.score ?? null,
        sourceTypes: [result.sourceType].filter(Boolean),
        documents: [result],
        primaryDocument: result,
        nodeDocument: isNodeDocument ? result : null,
        attachmentDocuments: isNodeDocument ? [] : [result],
      });
      return;
    }

    existingGroup.documents.push(result);

    if (result.sourceType && !existingGroup.sourceTypes.includes(result.sourceType)) {
      existingGroup.sourceTypes.push(result.sourceType);
    }

    if (result.sourceType === 'node') {
      existingGroup.nodeDocument = existingGroup.nodeDocument ?? result;
    } else if (result.sourceType === 'attachment') {
      existingGroup.attachmentDocuments.push(result);
    }

    if ((result.score ?? -Infinity) > (existingGroup.score ?? -Infinity)) {
      existingGroup.score = result.score ?? null;
      existingGroup.primaryDocument = result;
    }
  });

  return Array.from(groupedResults.values()).sort((left, right) => {
    return (right.score ?? -Infinity) - (left.score ?? -Infinity);
  });
}

async function fetchNodeDocumentsForGroups({ endpoint, indexName, queryKey, groups }) {
  const missingNodeGroups = groups.filter((group) => {
    return !group.nodeDocument && group.treeId && group.nodeId;
  });

  if (missingNodeGroups.length === 0) {
    return new Map();
  }

  const nodePairFilter = missingNodeGroups
    .map((group) => {
      return `(treeId eq '${escapeODataString(group.treeId)}' and nodeId eq '${escapeODataString(group.nodeId)}')`;
    })
    .join(' or ');
  const filterClauses = [`sourceType eq 'node'`, `(${nodePairFilter})`];

  if (applicationIdentifier) {
    filterClauses.push(`appIdentifier eq '${escapeODataString(applicationIdentifier)}'`);
  }

  const response = await fetch(
    `${endpoint}/indexes/${encodeURIComponent(indexName)}/docs/search?api-version=${SEARCH_API_VERSION}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': queryKey,
      },
      body: JSON.stringify({
        search: '*',
        top: missingNodeGroups.length,
        searchMode: 'all',
        filter: filterClauses.join(' and '),
        select: SEARCH_SELECT_FIELDS.join(','),
      }),
      cache: 'no-store',
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Azure Search node lookup failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  const nodeDocuments = Array.isArray(payload.value)
    ? payload.value.map(normalizeSearchDocument)
    : [];

  return new Map(
    nodeDocuments.map((document) => [`${document.treeId}::${document.nodeId}`, document]),
  );
}

function finalizeGroupedResults(groups) {
  return groups.map((group) => {
    const attachmentDocuments = group.attachmentDocuments
      .slice()
      .sort((left, right) => (right.score ?? -Infinity) - (left.score ?? -Infinity));
    const nodeDocument = group.nodeDocument ?? null;
    const matchedNodeDocument = group.documents.find((document) => document.sourceType === 'node') ?? null;
    const preferredDocument = nodeDocument ?? group.primaryDocument;
    const nodeHighlight = buildNodeHighlightInfo(matchedNodeDocument);
    const attachmentSummaries = attachmentDocuments.map((attachmentDocument) => ({
      ...(function buildAttachmentSummary() {
        const attachmentHighlight = buildAttachmentHighlightInfo(attachmentDocument);

        return {
          id: attachmentDocument.id,
          fileName: attachmentDocument.attachmentFileName || 'Attachment',
          blobName: attachmentDocument.blobName || null,
          blobUrl: attachmentDocument.blobUrl || null,
          matchSource: attachmentHighlight.source || 'content',
          score: attachmentDocument.score ?? null,
          summary: attachmentHighlight.text
            || buildSummaryText(
              attachmentDocument.content
                || attachmentDocument.ocrText
                || attachmentDocument.imageDescriptionFiltered
                || attachmentDocument.imageDescription
                || attachmentDocument.attachmentFileName,
            )
            || 'No preview text is available for this attachment match.',
        };
      }()),
    }));

    return {
      ...group,
      title: preferredDocument?.title
        || preferredDocument?.nodeText
        || attachmentDocuments[0]?.attachmentFileName
        || 'Untitled result',
      treeDisplayName: preferredDocument?.treeDisplayName || null,
      breadcrumb: preferredDocument?.breadcrumb
        || preferredDocument?.treeDisplayName
        || `Tree ${group.treeId}`,
      nodeIdPath: preferredDocument?.nodeIdPath || null,
      updatedAt: preferredDocument?.updatedAt || null,
      nodeScore: matchedNodeDocument?.score ?? 0,
      nodeDocument,
      nodeHighlight: nodeHighlight.text,
      nodeHighlightSource: nodeHighlight.source,
      attachmentDocuments,
      attachmentSummaries,
    };
  }).sort((left, right) => {
    return (right.score ?? -Infinity) - (left.score ?? -Infinity);
  });
}

export async function searchTreeContent({
  searchText,
  treeId,
  top,
  allowedTreeIds,
  defaultTop = DEFAULT_SEARCH_PAGE_TOP,
  includeExecutedSearches = false,
  searchMode = 'all',
}) {
  const trimmedSearchText = String(searchText ?? '').trim();

  if (!trimmedSearchText) {
    return {
      count: 0,
      results: [],
    };
  }

  const { endpoint, indexName, queryKey } = getRequiredSearchConfig();
  const normalizedTopValue = normalizeTop(top, defaultTop);
  const baseFilter = buildFilter({ treeId, allowedTreeIds });
  const attachmentFileNameRegexQuery = buildAttachmentFileNameRegexQuery(trimmedSearchText);
  const [nodeResults, attachmentResults, attachmentFileNameResults] = await Promise.all([
    executeSearchQuery({
      endpoint,
      indexName,
      queryKey,
      searchText: trimmedSearchText,
      top: normalizedTopValue,
      filter: `${baseFilter} and sourceType eq 'node'`,
      searchFields: NODE_SEARCH_FIELDS,
      scoringProfile: NODE_SCORING_PROFILE,
      searchMode,
    }),
    executeSearchQuery({
      endpoint,
      indexName,
      queryKey,
      searchText: trimmedSearchText,
      top: normalizedTopValue,
      filter: `${baseFilter} and sourceType eq 'attachment'`,
      searchFields: ATTACHMENT_SEARCH_FIELDS,
      searchMode,
    }),
    attachmentFileNameRegexQuery
      ? executeSearchQuery({
        endpoint,
        indexName,
        queryKey,
        searchText: attachmentFileNameRegexQuery,
        top: normalizedTopValue,
        filter: `${baseFilter} and sourceType eq 'attachment'`,
        searchFields: ['attachmentFileName'],
        queryType: 'full',
      })
      : Promise.resolve([]),
  ]);
  const normalizedAttachmentResults = mergeSearchDocuments(
    attachmentResults,
    addAttachmentMatchSource(attachmentFileNameResults, 'fileName'),
  );
  const normalizedResults = [...nodeResults, ...normalizedAttachmentResults];
  const filteredResults = filterDeepestResults(normalizedResults);
  const groupedResults = groupResultsByNode(filteredResults);
  const nodeDocumentsByGroupKey = await fetchNodeDocumentsForGroups({
    endpoint,
    indexName,
    queryKey,
    groups: groupedResults,
  });
  const enrichedGroups = groupedResults.map((group) => {
    const nodeDocument = nodeDocumentsByGroupKey.get(group.id);

    if (!nodeDocument) {
      return group;
    }

    return {
      ...group,
      parentNodeId: group.parentNodeId ?? nodeDocument.parentNodeId ?? null,
      nodeDocument,
    };
  });
  const finalizedGroups = finalizeGroupedResults(enrichedGroups);
  const {
    results: tokenCoverageFilteredResults,
    tokenCoverageFilter,
  } = applyTokenCoverageFilter(finalizedGroups, trimmedSearchText);
  const finalizedResults = tokenCoverageFilteredResults.slice(0, normalizedTopValue);

  const executedSearches = includeExecutedSearches
    ? [
      buildDebugSearchExecution({
        kind: 'node_content',
        query: trimmedSearchText,
        top: normalizedTopValue,
        filter: `${baseFilter} and sourceType eq 'node'`,
        searchFields: NODE_SEARCH_FIELDS,
        scoringProfile: NODE_SCORING_PROFILE,
        searchMode,
        results: nodeResults,
      }),
      buildDebugSearchExecution({
        kind: 'attachment_content',
        query: trimmedSearchText,
        top: normalizedTopValue,
        filter: `${baseFilter} and sourceType eq 'attachment'`,
        searchFields: ATTACHMENT_SEARCH_FIELDS,
        searchMode,
        results: attachmentResults,
      }),
      ...(attachmentFileNameRegexQuery
        ? [buildDebugSearchExecution({
          kind: 'attachment_file_name',
          query: attachmentFileNameRegexQuery,
          top: normalizedTopValue,
          filter: `${baseFilter} and sourceType eq 'attachment'`,
          searchFields: ['attachmentFileName'],
          queryType: 'full',
          searchMode: 'all',
          results: addAttachmentMatchSource(attachmentFileNameResults, 'fileName'),
        })]
        : []),
    ].filter((search) => Number(search?.resultCount ?? 0) > 0)
    : undefined;

  return {
    count: finalizedResults.length,
    results: finalizedResults,
    tokenCoverageFilter,
    ...(executedSearches ? { executedSearches } : {}),
  };
}

export {
  DEFAULT_SEARCH_PAGE_TOP,
  DEFAULT_TOOL_TOP,
  MAX_TOP,
};