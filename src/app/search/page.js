"use client";

import Image from "next/image";
import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import styles from "./page.module.css";

const IMAGE_FILE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);

function renderHighlightedText(text, keyPrefix) {
  const normalizedText = String(text ?? "");
  const parts = normalizedText.split("[[H]]");

  return parts.flatMap((part, partIndex) => {
    const [highlightedText, ...restSegments] = part.split("[[/H]]");
    const nodes = [];

    if (partIndex === 0) {
      if (highlightedText) {
        nodes.push(<span key={`${keyPrefix}-plain-${partIndex}`}>{highlightedText}</span>);
      }

      return nodes;
    }

    nodes.push(
      <mark key={`${keyPrefix}-highlight-${partIndex}`} className={styles.resultHighlight}>
        {highlightedText}
      </mark>,
    );

    const trailingText = restSegments.join("[[/H]]");

    if (trailingText) {
      nodes.push(<span key={`${keyPrefix}-trailing-${partIndex}`}>{trailingText}</span>);
    }

    return nodes;
  });
}

function formatUpdatedAt(value) {
  if (!value) {
    return null;
  }

  const parsedDate = new Date(value);

  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsedDate);
}

function buildAuditLabel(userDetails, timestamp, defaultLabel = null) {
  const parts = [];
  const normalizedUserDetails = String(userDetails ?? "").trim();
  const formattedTimestamp = formatUpdatedAt(timestamp);

  if (normalizedUserDetails) {
    parts.push(normalizedUserDetails);
  }

  if (formattedTimestamp) {
    parts.push(`Updated ${formattedTimestamp}`);
  }

  if (parts.length === 0) {
    return defaultLabel;
  }

  return parts.join(" • ");
}

function getBreadcrumbParts(result) {
  const breadcrumb = String(result.breadcrumb || "").trim();

  if (!breadcrumb) {
    return [result.treeDisplayName || `Tree ${result.treeId}`];
  }

  if (breadcrumb.includes(" / ")) {
    return breadcrumb.split(" / ").map((part) => part.trim()).filter(Boolean);
  }

  if (breadcrumb.includes(" > ")) {
    return breadcrumb.split(" > ").map((part) => part.trim()).filter(Boolean);
  }

  return [breadcrumb];
}

function getBreadcrumbItems(result, visibility = "public") {
  const breadcrumbParts = getBreadcrumbParts(result);
  const visibilityQuery = visibility === "public" ? "" : `&visibility=${encodeURIComponent(visibility)}`;
  const nodeHref = `/notes?treeId=${encodeURIComponent(result.treeId)}&nodeId=${encodeURIComponent(result.nodeId)}${visibilityQuery}`;
  const nodeIdPath = String(result.nodeIdPath || result.nodeDocument?.nodeIdPath || result.primaryDocument?.nodeIdPath || "").trim();
  const pathNodeIds = nodeIdPath
    ? nodeIdPath.split("/").map((part) => part.trim()).filter(Boolean)
    : [];

  return breadcrumbParts.map((part, index) => ({
    label: part,
    href: pathNodeIds.length === breadcrumbParts.length
      ? `/notes?treeId=${encodeURIComponent(result.treeId)}&nodeId=${encodeURIComponent(pathNodeIds[index])}${visibilityQuery}`
      : nodeHref,
    isLeaf: index === breadcrumbParts.length - 1,
  }));
}

function getPreviewType(attachmentSummary) {
  const fileName = String(attachmentSummary?.fileName || "").trim().toLowerCase();
  const blobName = String(attachmentSummary?.blobName || "").trim().toLowerCase();
  const candidate = fileName || blobName;

  if (!candidate) {
    return null;
  }

  const sanitizedCandidate = candidate.split("?")[0].split("#")[0];
  const extension = sanitizedCandidate.includes(".")
    ? sanitizedCandidate.slice(sanitizedCandidate.lastIndexOf(".") + 1)
    : "";

  if (IMAGE_FILE_EXTENSIONS.has(extension)) {
    return "image";
  }

  return null;
}

function getAttachmentContentUrl(attachmentSummary) {
  if (!attachmentSummary?.blobName) {
    return null;
  }

  return `/api/attachments/content?blobName=${encodeURIComponent(attachmentSummary.blobName)}`;
}

function getAttachmentBadgeLabel(attachmentSummary) {
  switch (attachmentSummary?.matchSource) {
    case "fileName":
      return "FILE NAME";
    case "ocrText":
      return "IMAGE OCR";
    case "imageDescription":
      return "IMAGE CONTENT";
    default:
      return "FILE CONTENT";
  }
}

function formatJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function formatCoveragePercent(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return `${Math.round(numericValue * 100)}%`;
}

function SearchPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryParam = searchParams.get("q") ?? "";
  const treeIdParam = searchParams.get("treeId") ?? "";
  const visibilityParam = searchParams.get("visibility") ?? "public";
  const queryInputRef = useRef(null);
  const [availableTrees, setAvailableTrees] = useState([]);
  const [isLoadingTrees, setIsLoadingTrees] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState([]);
  const [resultCount, setResultCount] = useState(0);
  const [executedSearches, setExecutedSearches] = useState([]);
  const [tokenCoverageFilter, setTokenCoverageFilter] = useState(null);
  const [treeError, setTreeError] = useState(null);
  const [searchError, setSearchError] = useState(null);

  useEffect(() => {
    let isCancelled = false;

    fetch(`/api/notes?visibility=${encodeURIComponent(visibilityParam)}`)
      .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (isCancelled) {
          return;
        }

        if (!ok) {
          throw new Error(data.error || "Failed to load trees");
        }

        setAvailableTrees(Array.isArray(data) ? data : []);
        setTreeError(null);
      })
      .catch((fetchError) => {
        if (isCancelled) {
          return;
        }

        console.error("Search tree list error:", fetchError);
        setAvailableTrees([]);
        setTreeError(fetchError.message);
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoadingTrees(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [visibilityParam]);

  useEffect(() => {
    if (!treeIdParam) {
      return;
    }

    if (availableTrees.some((tree) => String(tree.id) === String(treeIdParam))) {
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    nextSearchParams.delete("treeId");
    const nextQueryString = nextSearchParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  }, [availableTrees, pathname, router, searchParams, treeIdParam]);

  useEffect(() => {
    const trimmedQuery = queryParam.trim();

    if (!trimmedQuery) {
      return;
    }

    let isCancelled = false;
    const requestSearchParams = new URLSearchParams();
    requestSearchParams.set("q", trimmedQuery);
    requestSearchParams.set("visibility", visibilityParam);

    if (treeIdParam) {
      requestSearchParams.set("treeId", treeIdParam);
    }

    fetch(`/api/search?${requestSearchParams.toString()}`)
      .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (isCancelled) {
          return;
        }

        if (!ok) {
          throw new Error(data.error || "Search failed");
        }

        setResults(Array.isArray(data.results) ? data.results : []);
        setResultCount(Number(data.count ?? 0));
        setExecutedSearches(Array.isArray(data.executedSearches) ? data.executedSearches : []);
        setTokenCoverageFilter(data.tokenCoverageFilter && typeof data.tokenCoverageFilter === "object" ? data.tokenCoverageFilter : null);
        setSearchError(null);
      })
      .catch((searchError) => {
        if (isCancelled) {
          return;
        }

        console.error("Search request error:", searchError);
        setResults([]);
        setResultCount(0);
        setExecutedSearches([]);
        setTokenCoverageFilter(null);
        setSearchError(searchError.message);
      })
      .finally(() => {
        if (!isCancelled) {
          setIsSearching(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [queryParam, treeIdParam, visibilityParam]);

  const handleSubmit = (event) => {
    event.preventDefault();

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    const trimmedQuery = queryInputRef.current?.value?.trim() ?? "";

    if (trimmedQuery) {
      nextSearchParams.set("q", trimmedQuery);
      setIsSearching(true);
    } else {
      nextSearchParams.delete("q");
      setIsSearching(false);
    }

    if (treeIdParam) {
      nextSearchParams.set("treeId", treeIdParam);
    } else {
      nextSearchParams.delete("treeId");
    }

    if (visibilityParam && visibilityParam !== "public") {
      nextSearchParams.set("visibility", visibilityParam);
    } else {
      nextSearchParams.delete("visibility");
    }

    const nextQueryString = nextSearchParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  };

  const handleTreeChange = (event) => {
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    const nextTreeId = event.target.value;

    if (queryParam.trim()) {
      setIsSearching(true);
    }

    if (nextTreeId) {
      nextSearchParams.set("treeId", nextTreeId);
    } else {
      nextSearchParams.delete("treeId");
    }

    if (visibilityParam && visibilityParam !== "public") {
      nextSearchParams.set("visibility", visibilityParam);
    } else {
      nextSearchParams.delete("visibility");
    }

    const nextQueryString = nextSearchParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  };

  const handleVisibilityChange = (event) => {
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    const nextVisibility = event.target.value;

    setIsLoadingTrees(true);

    if (queryParam.trim()) {
      setIsSearching(true);
    }

    if (nextVisibility && nextVisibility !== "public") {
      nextSearchParams.set("visibility", nextVisibility);
    } else {
      nextSearchParams.delete("visibility");
    }

    const nextQueryString = nextSearchParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  };

  return (
    <main className={`${styles.pageShell} appPageShell`}>
      <section className={`appTopLevelPanel ${styles.heroCard}`}>
        <div className="appHeroCopy">
          <p className={`${styles.description} appPageDescription`}>
            Search notes and attachments across your accessible trees, then jump directly to the matching node path.
          </p>
        </div>

        <form onSubmit={handleSubmit} className={styles.searchForm}>
          <label className={styles.searchField}>
            <span className="appFieldLabel">Search</span>
            <input
              key={queryParam}
              ref={queryInputRef}
              type="search"
              defaultValue={queryParam}
              placeholder="Try a node title, note text, or attachment phrase"
              className={`appTextControl ${styles.textInput}`}
            />
          </label>

          <label className={styles.filterField}>
            <span className="appFieldLabel">Tree</span>
            <select
              value={treeIdParam}
              onChange={handleTreeChange}
              disabled={isLoadingTrees}
              className={`appSelectControl ${styles.selectInput}`}
            >
              <option value="">All trees</option>
              {availableTrees.map((tree) => (
                <option key={tree.id} value={tree.id}>
                  {tree.name}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.filterField}>
            <span className="appFieldLabel">Visibility</span>
            <select
              value={visibilityParam}
              onChange={handleVisibilityChange}
              className={`appSelectControl ${styles.selectInput}`}
            >
              <option value="public">Public</option>
              <option value="private">Private</option>
              <option value="both">Both</option>
            </select>
          </label>

          <button type="submit" className="appPrimaryFormButton">
            {isSearching ? "Searching..." : "Search"}
          </button>
        </form>
      </section>

      {treeError ? <p className={styles.errorMessage}>{treeError}</p> : null}
      {searchError ? <p className={styles.errorMessage}>{searchError}</p> : null}

      {!queryParam.trim() ? (
        <section className={`appTopLevelPanel ${styles.topLevelEmptyState}`}>
          <h2>Start with a phrase</h2>
          <p>Search runs against both SQL-backed node content and blob attachment content in the shared index.</p>
        </section>
      ) : (
        <section className={`appTopLevelPanel ${styles.resultsSection}`}>
          <div className={styles.resultsHeader}>
            <div>
              <p className={styles.resultsEyebrow}>Node Results</p>
              <h2 className={styles.resultsTitle}>{resultCount} match{resultCount === 1 ? "" : "es"}</h2>
            </div>
          </div>

          {executedSearches.length > 0 || tokenCoverageFilter ? (
            <section className={styles.debugSection}>
              <div className={styles.debugHeader}>
                <p className={styles.resultsEyebrow}>Executed Queries</p>
                <p className={styles.debugSummary}>{executedSearches.length} search{executedSearches.length === 1 ? "" : "es"} recorded</p>
              </div>
              {tokenCoverageFilter ? (
                <details className={styles.debugCard} open>
                  <summary className={styles.debugCardSummary}>
                    <span className={styles.debugKind}>token coverage filter</span>
                    <span className={styles.debugMeta}>
                      {tokenCoverageFilter.enabled ? "enabled" : "disabled"} · threshold {formatCoveragePercent(tokenCoverageFilter.threshold)}
                    </span>
                  </summary>
                  <div className={styles.debugCardBody}>
                    <dl className={styles.debugFacts}>
                      <div className={styles.debugFactRow}>
                        <dt>Results kept</dt>
                        <dd>{Number(tokenCoverageFilter.resultCountAfter ?? 0)} of {Number(tokenCoverageFilter.resultCountBefore ?? 0)}</dd>
                      </div>
                      <div className={styles.debugFactRow}>
                        <dt>Minimum token count</dt>
                        <dd>{Number(tokenCoverageFilter.minimumMatchedTokenCount ?? 0)}</dd>
                      </div>
                      <div className={styles.debugFactRow}>
                        <dt>Query tokens</dt>
                        <dd>{Array.isArray(tokenCoverageFilter.queryTokens) && tokenCoverageFilter.queryTokens.length > 0 ? tokenCoverageFilter.queryTokens.join(", ") : "n/a"}</dd>
                      </div>
                    </dl>
                    <details className={styles.debugJsonToggle}>
                      <summary className={styles.debugJsonSummary}>Show full payload</summary>
                      <pre className={styles.debugJson}>{formatJson(tokenCoverageFilter)}</pre>
                    </details>
                  </div>
                </details>
              ) : null}
              <div className={styles.debugList}>
                {executedSearches.map((search, index) => (
                  <details key={`${search.kind}-${index}`} className={styles.debugCard}>
                    <summary className={styles.debugCardSummary}>
                      <span className={styles.debugKind}>{search.kind}</span>
                      <span className={styles.debugMeta}>mode {search.searchMode || "n/a"} · {search.resultCount} result{search.resultCount === 1 ? "" : "s"}</span>
                    </summary>
                    <div className={styles.debugCardBody}>
                      <dl className={styles.debugFacts}>
                        <div className={styles.debugFactRow}>
                          <dt>Query</dt>
                          <dd>{String(search.query ?? "") || "n/a"}</dd>
                        </div>
                        <div className={styles.debugFactRow}>
                          <dt>Mode</dt>
                          <dd>{String(search.searchMode ?? "n/a")}</dd>
                        </div>
                        <div className={styles.debugFactRow}>
                          <dt>Results</dt>
                          <dd>{Number(search.resultCount ?? 0)}</dd>
                        </div>
                      </dl>
                      <details className={styles.debugJsonToggle}>
                        <summary className={styles.debugJsonSummary}>Show full payload</summary>
                        <pre className={styles.debugJson}>{formatJson(search)}</pre>
                      </details>
                    </div>
                  </details>
                ))}
              </div>
            </section>
          ) : null}

          {results.length === 0 && !isSearching && !searchError ? (
            <div className={styles.emptyState}>
              <h2>No matches</h2>
              <p>Try a broader phrase or remove the tree filter.</p>
            </div>
          ) : (
            <div className={styles.resultList}>
              {results.map((result) => (
                <article key={result.id} className={styles.resultCard}>
                  {(() => {
                    const breadcrumbItems = getBreadcrumbItems(result, visibilityParam);

                    return (
                      <div className={styles.resultMetaRow}>
                        <div className={styles.resultBreadcrumbTrail}>
                          <span className={styles.resultTreeLabel}>Node: {result.treeDisplayName || result.treeId}</span>
                          {breadcrumbItems.map((item, index) => (
                            <span key={`${result.id}-crumb-${index}`} className={styles.resultBreadcrumbItem}>
                              <span className={styles.resultBreadcrumbSeparator}>/</span>
                              <Link
                                href={item.href}
                                className={styles.resultBreadcrumbLink}
                              >
                                <span className={item.isLeaf ? styles.resultBreadcrumbLeaf : styles.resultBreadcrumbPart}>
                                  {item.label}
                                </span>
                              </Link>
                            </span>
                          ))}
                        </div>
                        <span className={styles.resultScore}>Score {Number(result.nodeScore ?? 0).toFixed(2)}</span>
                      </div>
                    );
                  })()}
                  {result.nodeHighlight ? (
                    <section className={styles.resultInlineSection}>
                      {result.nodeHighlightSource ? (
                        <span className={styles.resultType}>{result.nodeHighlightSource}</span>
                      ) : null}
                      <p className={`${styles.resultSnippet} ${styles.resultSnippetCode}`}>{renderHighlightedText(result.nodeHighlight, `${result.id}-node-highlight`)}</p>
                    </section>
                  ) : null}
                  {Array.isArray(result.attachmentSummaries) && result.attachmentSummaries.length > 0 ? (
                    <section className={styles.resultSection}>
                      <div className={styles.attachmentSummaryList}>
                        {result.attachmentSummaries.map((attachmentSummary) => (
                          <div
                            key={attachmentSummary.id}
                            className={styles.attachmentSummaryCard}
                          >
                            <div className={styles.attachmentSummaryMetaRow}>
                              <div className={styles.attachmentSummaryBadges}>
                                <span className={styles.resultType}>{getAttachmentBadgeLabel(attachmentSummary)}</span>
                              </div>
                              <span className={styles.resultScore}>
                                Score {attachmentSummary.score ? attachmentSummary.score.toFixed(2) : "n/a"}
                              </span>
                            </div>
                            <p className={`${styles.attachmentSummaryText} ${styles.resultSnippetCode}`}>{renderHighlightedText(attachmentSummary.summary, `${attachmentSummary.id}-attachment-summary`)}</p>
                            {buildAuditLabel(attachmentSummary.updatedByUserDetails, attachmentSummary.updatedAt ?? attachmentSummary.createdAt) ? (
                              <p className={styles.resultAuditText}>
                                {buildAuditLabel(attachmentSummary.updatedByUserDetails, attachmentSummary.updatedAt ?? attachmentSummary.createdAt)}
                              </p>
                            ) : null}
                            {getAttachmentContentUrl(attachmentSummary) ? (
                              <div className={styles.attachmentPreviewRow}>
                                <div className={styles.attachmentPreviewDetails}>
                                  <span className={styles.attachmentPreviewFileName}>{attachmentSummary.fileName}</span>
                                </div>
                                {getPreviewType(attachmentSummary) === "image" ? (
                                  <div className={styles.attachmentPreviewFrame}>
                                    <Image
                                      src={getAttachmentContentUrl(attachmentSummary)}
                                      alt={attachmentSummary.fileName || "Attachment preview"}
                                      width={240}
                                      height={180}
                                      sizes="240px"
                                      className={styles.attachmentPreviewImage}
                                      unoptimized
                                    />
                                  </div>
                                ) : null}
                                <a
                                  href={getAttachmentContentUrl(attachmentSummary)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={styles.attachmentOpenLink}
                                >
                                  Open
                                </a>
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  <div className={styles.resultFooter}>
                    <div className={styles.resultFacts}>
                      {buildAuditLabel(result.updatedByUserDetails, result.updatedAt) ? (
                        <span>{buildAuditLabel(result.updatedByUserDetails, result.updatedAt)}</span>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </main>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div>Loading search...</div>}>
      <SearchPageContent />
    </Suspense>
  );
}
