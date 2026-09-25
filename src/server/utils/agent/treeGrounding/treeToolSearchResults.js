import { buildAgentToolResult } from '@/server/utils/agent/agentToolResult';

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function getUsableEvidenceText(value) {
  const normalizedText = normalizeWhitespace(value);

  return normalizedText || null;
}

function buildNodeEvidenceItem(nodeDocument) {
  const notes = getUsableEvidenceText(nodeDocument?.notes);

  if (!notes) {
    return null;
  }

  return {
    kind: 'node',
    source: 'notes',
    text: notes,
  };
}

function buildAttachmentEvidenceItems(attachmentDocument) {
  const content = getUsableEvidenceText(attachmentDocument?.content);
  const ocrText = getUsableEvidenceText(attachmentDocument?.ocrText);
  const filteredImageDescription = getUsableEvidenceText(attachmentDocument?.imageDescriptionFiltered);
  const baseAttachment = {
    kind: 'attachment',
    fileName: attachmentDocument?.attachmentFileName || 'Attachment',
    blobName: attachmentDocument?.blobName || null,
    blobUrl: attachmentDocument?.blobUrl || null,
  };

  return [
    content
      ? {
        ...baseAttachment,
        source: 'fileContent',
        text: content,
      }
      : null,
    ocrText
      ? {
        ...baseAttachment,
        source: 'ocrText',
        text: ocrText,
      }
      : null,
    filteredImageDescription
      ? {
        ...baseAttachment,
        source: 'imageDescriptionFiltered',
        text: filteredImageDescription,
      }
      : null,
  ].filter(Boolean);
}

export function buildAgentSearchResult(rawResult) {
  const results = (rawResult?.results ?? []).map((entry) => {
    const nodeEvidenceItem = buildNodeEvidenceItem(entry?.nodeDocument);
    const attachmentEvidenceItems = (entry?.attachmentDocuments ?? [])
      .flatMap((attachmentDocument) => buildAttachmentEvidenceItems(attachmentDocument));
    const evidenceItems = [nodeEvidenceItem, ...attachmentEvidenceItems].filter(Boolean);

    if (evidenceItems.length === 0) {
      return null;
    }

    return {
      treeId: entry.treeId,
      nodeId: entry.nodeId,
      title: entry.title,
      breadcrumb: entry.breadcrumb,
      nodeIdPath: entry.nodeIdPath,
      treeDisplayName: entry.treeDisplayName,
      matchSummary: entry.nodeHighlight
        || entry.attachmentSummaries?.find((attachment) => normalizeWhitespace(attachment?.summary))?.summary
        || null,
      evidenceItems,
      attachmentFileNames: attachmentEvidenceItems.map((item) => item.fileName),
    };
  }).filter(Boolean);

  return {
    count: results.length,
    results,
  };
}

export function buildDebugSearchResultSnapshot(rawResult) {
  return {
    searches: Array.isArray(rawResult?.executedSearches) ? rawResult.executedSearches : [],
    tokenCoverageFilter: rawResult?.tokenCoverageFilter ?? null,
  };
}

export function buildTreeToolHandlerResult({
  sourceToolFamily,
  toolName,
  toolOutput,
  searchResult = null,
  includeDebug = false,
}) {
  const wrappedToolOutput = buildAgentToolResult({
    sourceToolFamily,
    toolName,
    toolResultType: 'search_results',
    data: toolOutput,
    meta: {
      resultCount: Number(toolOutput?.count ?? 0),
      supportsCitations: true,
      generatedAt: new Date().toISOString(),
    },
    ...(includeDebug
      ? {
        debug: {
          searchResult,
        },
      }
      : {}),
  });

  if (!includeDebug) {
    return {
      toolOutput: wrappedToolOutput,
    };
  }

  return {
    toolOutput: wrappedToolOutput,
    debug: {
      searchResult,
      toolOutput: wrappedToolOutput,
    },
  };
}