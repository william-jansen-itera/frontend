"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import styles from "./page.module.css";

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

function getBreadcrumbItems(result) {
  const breadcrumbParts = getBreadcrumbParts(result);
  const nodeHref = `/notes?treeId=${encodeURIComponent(result.treeId)}&nodeId=${encodeURIComponent(result.nodeId)}`;
  const nodeIdPath = String(result.nodeIdPath || result.nodeDocument?.nodeIdPath || result.primaryDocument?.nodeIdPath || "").trim();
  const pathNodeIds = nodeIdPath
    ? nodeIdPath.split("/").map((part) => part.trim()).filter(Boolean)
    : [];

  return breadcrumbParts.map((part, index) => ({
    label: part,
    href: pathNodeIds.length === breadcrumbParts.length
      ? `/notes?treeId=${encodeURIComponent(result.treeId)}&nodeId=${encodeURIComponent(pathNodeIds[index])}`
      : nodeHref,
    isLeaf: index === breadcrumbParts.length - 1,
  }));
}

function SearchPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryParam = searchParams.get("q") ?? "";
  const treeIdParam = searchParams.get("treeId") ?? "";
  const queryInputRef = useRef(null);
  const [availableTrees, setAvailableTrees] = useState([]);
  const [isLoadingTrees, setIsLoadingTrees] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState([]);
  const [resultCount, setResultCount] = useState(0);
  const [treeError, setTreeError] = useState(null);
  const [searchError, setSearchError] = useState(null);

  useEffect(() => {
    let isCancelled = false;

    fetch("/api/notes")
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
  }, []);

  useEffect(() => {
    const trimmedQuery = queryParam.trim();

    if (!trimmedQuery) {
      return;
    }

    let isCancelled = false;
    const requestSearchParams = new URLSearchParams();
    requestSearchParams.set("q", trimmedQuery);

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
        setSearchError(null);
      })
      .catch((searchError) => {
        if (isCancelled) {
          return;
        }

        console.error("Search request error:", searchError);
        setResults([]);
        setResultCount(0);
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
  }, [queryParam, treeIdParam]);

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

    const nextQueryString = nextSearchParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  };

  return (
    <main className={styles.pageShell}>
      <section className={styles.heroCard}>
        <form onSubmit={handleSubmit} className={styles.searchForm}>
          <label className={styles.searchField}>
            <span className={styles.fieldLabel}>Search</span>
            <input
              key={queryParam}
              ref={queryInputRef}
              type="search"
              defaultValue={queryParam}
              placeholder="Try a node title, note text, or attachment phrase"
              className={styles.textInput}
            />
          </label>

          <label className={styles.filterField}>
            <span className={styles.fieldLabel}>Tree</span>
            <select
              value={treeIdParam}
              onChange={handleTreeChange}
              disabled={isLoadingTrees}
              className={styles.selectInput}
            >
              <option value="">All trees</option>
              {availableTrees.map((tree) => (
                <option key={tree.id} value={tree.id}>
                  {tree.name}
                </option>
              ))}
            </select>
          </label>

          <button type="submit" className={styles.searchButton}>
            {isSearching ? "Searching..." : "Search"}
          </button>
        </form>
      </section>

      {treeError ? <p className={styles.errorMessage}>{treeError}</p> : null}
      {searchError ? <p className={styles.errorMessage}>{searchError}</p> : null}

      {!queryParam.trim() ? (
        <section className={styles.emptyState}>
          <h2>Start with a phrase</h2>
          <p>Search runs against both SQL-backed node content and blob attachment content in the shared index.</p>
        </section>
      ) : (
        <section className={styles.resultsSection}>
          <div className={styles.resultsHeader}>
            <div>
              <p className={styles.resultsEyebrow}>Node Results</p>
              <h2 className={styles.resultsTitle}>{resultCount} match{resultCount === 1 ? "" : "es"}</h2>
            </div>
          </div>

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
                    const breadcrumbItems = getBreadcrumbItems(result);

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
                                <span className={styles.resultType}>FILE CONTENT</span>
                                <span className={styles.resultMatchChip}>{attachmentSummary.fileName}</span>
                              </div>
                              <span className={styles.resultScore}>
                                Score {attachmentSummary.score ? attachmentSummary.score.toFixed(2) : "n/a"}
                              </span>
                            </div>
                            <p className={`${styles.attachmentSummaryText} ${styles.resultSnippetCode}`}>{renderHighlightedText(attachmentSummary.summary, `${attachmentSummary.id}-attachment-summary`)}</p>
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  <div className={styles.resultFooter}>
                    <div className={styles.resultFacts}>
                      {formatUpdatedAt(result.updatedAt) ? <span>Updated {formatUpdatedAt(result.updatedAt)}</span> : null}
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
