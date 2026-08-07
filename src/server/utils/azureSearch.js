const searchEndpoint = process.env.AZURE_SEARCH_ENDPOINT;
const searchIndexName = process.env.AZURE_SEARCH_INDEX_NAME;
const searchQueryKey = process.env.AZURE_SEARCH_QUERY_KEY || process.env.AZURE_SEARCH_ADMIN_KEY;
const applicationIdentifier = process.env.APPLICATION_IDENTIFIER;
const SEARCH_API_VERSION = '2024-07-01';
const DEFAULT_TOP = 10;
const MAX_TOP = 25;
const NODE_SCORING_PROFILE = 'node-content-priority';
const NODE_SEARCH_FIELDS = ['content', 'title', 'breadcrumb'];
const ATTACHMENT_SEARCH_FIELDS = ['content', 'ocrText', 'imageDescriptionFiltered', 'attachmentFileName'];
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

function normalizeTop(value) {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_TOP;
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

async function executeSearchQuery({ endpoint, indexName, queryKey, searchText, filter, top, searchFields, scoringProfile = null, queryType = null }) {
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
        searchMode: 'all',
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

export async function searchTreeContent({ searchText, treeId, top, allowedTreeIds }) {
  const trimmedSearchText = String(searchText ?? '').trim();

  if (!trimmedSearchText) {
    return {
      count: 0,
      results: [],
    };
  }

  const { endpoint, indexName, queryKey } = getRequiredSearchConfig();
  const normalizedTopValue = normalizeTop(top);
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
    }),
    executeSearchQuery({
      endpoint,
      indexName,
      queryKey,
      searchText: trimmedSearchText,
      top: normalizedTopValue,
      filter: `${baseFilter} and sourceType eq 'attachment'`,
      searchFields: ATTACHMENT_SEARCH_FIELDS,
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
  const finalizedResults = finalizeGroupedResults(enrichedGroups).slice(0, normalizedTopValue);

  return {
    count: finalizedResults.length,
    results: finalizedResults,
  };
}