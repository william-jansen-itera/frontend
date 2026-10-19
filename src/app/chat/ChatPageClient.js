"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/app/useAuth";
import styles from "./page.module.css";
import { AgentAnswerContent } from "./AgentAnswerContent";
import {
  buildChatPlaceholder,
  fetchAvailableChatFamilies,
  normalizeChatFamilySelection,
  parseApiResponseBody,
  setChatFamilySearchParam,
} from "./agentFamilyPublishing";
import {
  ALL_VISIBILITY_VALUES,
  buildVisibilityHref,
  PUBLIC_PRIVATE_VISIBILITY_VALUES,
  setVisibilitySearchParam,
  usePersistedVisibility,
} from "../usePersistedVisibility";

const KNOWLEDGE_MODE_GROUNDED = "grounded";
const KNOWLEDGE_MODE_BROAD = "broad";
const DEFAULT_CHAT_FAMILY = "knowledgeTrees";
const DEFAULT_CHAT_VISIBILITY = "both";
let fallbackTurnSequence = 0;
let fallbackRequestSequence = 0;

function createTurnId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  fallbackTurnSequence += 1;
  return `turn-${fallbackTurnSequence}`;
}

function createRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  fallbackRequestSequence += 1;
  return `request-${fallbackRequestSequence}`;
}

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

function buildHistoryFromTurns(turns) {
  return turns.flatMap((turn) => {
    const messages = [];
    const userHistoryText = String(turn?.question ?? "").trim();

    const assistantHistoryText = String(turn?.answer ?? "").trim();

    if (userHistoryText) {
      messages.push({ role: "user", content: userHistoryText });
    }

    if (assistantHistoryText) {
      messages.push({ role: "assistant", content: assistantHistoryText });
    }

    return messages;
  });
}

function resolvePreferredDefaultChatFamily(availableFamilies, fallbackFamily = null) {
  const availableFamilyNames = Array.isArray(availableFamilies)
    ? availableFamilies.map((family) => String(family?.family ?? "").trim()).filter(Boolean)
    : [];

  if (availableFamilyNames.includes(DEFAULT_CHAT_FAMILY)) {
    return DEFAULT_CHAT_FAMILY;
  }

  const normalizedFallbackFamily = String(fallbackFamily ?? "").trim();

  if (normalizedFallbackFamily && availableFamilyNames.includes(normalizedFallbackFamily)) {
    return normalizedFallbackFamily;
  }

  return availableFamilyNames[0] ?? null;
}

function formatTimestamp(value) {
  if (!value) {
    return "n/a";
  }

  const dateValue = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(dateValue.getTime())) {
    return "n/a";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(dateValue);
}

function formatDuration(value) {
  const durationMs = Number(value);

  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "n/a";
  }

  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }

  return `${(durationMs / 1000).toFixed(1)} s`;
}

function buildUserMessageLabel(user) {
  const displayName = String(user?.displayName ?? "").trim();

  if (displayName) {
    return displayName;
  }

  const preferredUsername = String(user?.preferredUsername ?? user?.userDetails ?? "").trim();

  if (preferredUsername) {
    return preferredUsername;
  }

  return "User";
}

function formatJson(value) {
  if (value === undefined) {
    return "undefined";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ serializationError: "Value could not be serialized." }, null, 2);
  }
}

function buildTimingDebugEntries({ timings, toolCalls }) {
  const phaseEntries = timings?.phases && typeof timings.phases === "object"
    ? Object.entries(timings.phases).map(([phaseName, phaseTiming]) => ({
      key: `phase-${phaseName}`,
      label: phaseName,
      startedAt: phaseTiming?.startedAt ?? null,
      completedAt: phaseTiming?.completedAt ?? null,
      durationMs: phaseTiming?.durationMs ?? null,
      meta: "phase",
    }))
    : [];

  const extraTimingEntries = Object.entries(timings ?? {})
    .filter(([key, value]) => !["requestStartedAt", "requestCompletedAt", "totalDurationMs", "modelCalls", "phases"].includes(key))
    .filter(([, value]) => value && typeof value === "object" && !Array.isArray(value) && ("startedAt" in value || "durationMs" in value))
    .map(([key, value]) => ({
      key: `extra-${key}`,
      label: key,
      startedAt: value?.startedAt ?? null,
      completedAt: value?.completedAt ?? null,
      durationMs: value?.durationMs ?? null,
      meta: value?.executed === false ? "not executed" : "timing",
    }));

  const modelEntries = Array.isArray(timings?.modelCalls)
    ? timings.modelCalls.map((entry, index) => ({
      key: `model-${entry?.phase ?? index}-${entry?.round ?? 0}`,
      label: entry?.phase ? String(entry.phase) : `model call ${index + 1}`,
      startedAt: entry?.startedAt ?? null,
      completedAt: entry?.completedAt ?? null,
      durationMs: entry?.durationMs ?? null,
      meta: entry?.round ? `round ${entry.round}` : null,
    }))
    : [];

  const toolEntries = Array.isArray(toolCalls)
    ? toolCalls.map((entry, index) => ({
      key: `tool-${entry?.callId ?? index}`,
      label: entry?.toolName ? `tool: ${entry.toolName}` : `tool call ${index + 1}`,
      startedAt: entry?.startedAt ?? null,
      completedAt: entry?.completedAt ?? null,
      durationMs: entry?.durationMs ?? null,
      meta: entry?.round ? `round ${entry.round}` : null,
    }))
    : [];

  return [...phaseEntries, ...extraTimingEntries, ...modelEntries, ...toolEntries]
    .filter((entry) => entry.startedAt || entry.completedAt || entry.durationMs !== null)
    .sort((left, right) => {
      const leftTime = left.startedAt ? new Date(left.startedAt).getTime() : Number.POSITIVE_INFINITY;
      const rightTime = right.startedAt ? new Date(right.startedAt).getTime() : Number.POSITIVE_INFINITY;
      return leftTime - rightTime;
    });
}

function buildTimingDebugJson({ timings, toolCalls, orderedEntries }) {
  return {
    requestStartedAt: timings?.requestStartedAt ?? null,
    requestCompletedAt: timings?.requestCompletedAt ?? null,
    totalDurationMs: timings?.totalDurationMs ?? null,
    phases: timings?.phases ?? null,
    modelCalls: Array.isArray(timings?.modelCalls) ? timings.modelCalls : [],
    toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
    orderedEntries,
    extraTimings: Object.fromEntries(
      Object.entries(timings ?? {}).filter(([key]) => !["requestStartedAt", "requestCompletedAt", "totalDurationMs", "modelCalls", "phases"].includes(key)),
    ),
  };
}

function formatDateTimeTimestamp(value) {
  if (!value) {
    return "n/a";
  }

  const dateValue = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(dateValue.getTime())) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(dateValue);
}

function getErrorMessage(error, fallbackMessage) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallbackMessage;
}

function getCitationBreadcrumbParts(citation) {
  const breadcrumb = String(citation?.breadcrumb ?? "").trim();

  if (!breadcrumb) {
    const fallbackLabel = String(citation?.treeDisplayName ?? citation?.treeId ?? citation?.nodeId ?? "").trim();
    return fallbackLabel ? [fallbackLabel] : [];
  }

  return breadcrumb
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean);
}

function getCitationBreadcrumbItems(citation, visibility = "public") {
  const breadcrumbParts = getCitationBreadcrumbParts(citation);
  const nodeIdPath = String(citation?.nodeIdPath || "").trim();
  const pathNodeIds = nodeIdPath
    ? nodeIdPath.split("/").map((part) => part.trim()).filter(Boolean)
    : [];
  const citationVisibility = String(citation?.visibility ?? "").trim().toLowerCase();
  const resolvedVisibility = PUBLIC_PRIVATE_VISIBILITY_VALUES.includes(citationVisibility)
    ? citationVisibility
    : visibility;
  const buildNotesHref = (nodeId) => {
    const notesSearchParams = new URLSearchParams();
    notesSearchParams.set("treeId", String(citation.treeId));
    notesSearchParams.set("nodeId", String(nodeId));
    return buildVisibilityHref("/notes", notesSearchParams.toString(), resolvedVisibility, PUBLIC_PRIVATE_VISIBILITY_VALUES);
  };
  const nodeHref = buildNotesHref(citation.nodeId);

  return breadcrumbParts.map((part, index) => ({
    label: part,
    href: pathNodeIds.length === breadcrumbParts.length
      ? buildNotesHref(pathNodeIds[index])
      : nodeHref,
    isLeaf: index === breadcrumbParts.length - 1,
  }));
}

function CitationHighlightToggle({ matchSummary, summaryKey }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!matchSummary) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className={styles.citationDisclosureToggle}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((currentValue) => !currentValue)}
      >
        Highlight from source
      </button>
      {isOpen ? (
        <p className={styles.citationSummary}>
          {renderHighlightedText(matchSummary, summaryKey)}
        </p>
      ) : null}
    </>
  );
}

function CitationBreadcrumbs({ citations, visibility }) {
  if (!Array.isArray(citations) || citations.length === 0) {
    return null;
  }

  return (
    <div className={styles.citationSection}>
      <p className={styles.citationEyebrow}>Grounding nodes</p>
      <div className={styles.citationList}>
        {citations.map((citation, index) => {
          const breadcrumbItems = getCitationBreadcrumbItems(citation, visibility);
          const key = `${citation.treeId}-${citation.nodeId}-${index}`;
          const matchSummary = String(citation?.matchSummary ?? "").trim();

          return (
            <div key={key} className={styles.citationCard}>
              <div className={styles.resultBreadcrumbTrail}>
                <span className={styles.resultTreeLabel}>Node: {citation.treeDisplayName || citation.treeId}</span>
                {breadcrumbItems.map((item, itemIndex) => (
                  <span key={`${key}-crumb-${itemIndex}`} className={styles.resultBreadcrumbItem}>
                    <span className={styles.resultBreadcrumbSeparator}>/</span>
                    <Link href={item.href} className={styles.resultBreadcrumbLink}>
                      <span className={item.isLeaf ? styles.resultBreadcrumbLeaf : styles.resultBreadcrumbPart}>
                        {item.label}
                      </span>
                    </Link>
                  </span>
                ))}
                <CitationHighlightToggle matchSummary={matchSummary} summaryKey={`${key}-summary`} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatCoveragePercent(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return `${Math.round(numericValue * 100)}%`;
}

function ToolTokenCoverageSummary({ tokenCoverageFilter }) {
  if (!tokenCoverageFilter || typeof tokenCoverageFilter !== "object") {
    return null;
  }

  const queryTokens = Array.isArray(tokenCoverageFilter.queryTokens) ? tokenCoverageFilter.queryTokens : [];

  return (
    <div className={styles.searchExecutionCard}>
      <div className={styles.searchExecutionHeader}>
        <span className={styles.searchExecutionKind}>token coverage filter</span>
        <span className={styles.searchExecutionMeta}>
          {tokenCoverageFilter.enabled ? "enabled" : "disabled"} · threshold {formatCoveragePercent(tokenCoverageFilter.threshold)}
        </span>
      </div>
      <p className={styles.searchExecutionQuery}>
        kept {Number(tokenCoverageFilter.resultCountAfter ?? 0)} of {Number(tokenCoverageFilter.resultCountBefore ?? 0)} grouped result{Number(tokenCoverageFilter.resultCountBefore ?? 0) === 1 ? "" : "s"}
        {queryTokens.length > 0 ? ` · ${queryTokens.length} query token${queryTokens.length === 1 ? "" : "s"}` : ""}
      </p>
    </div>
  );
}

function ToolSearchExecutionSummary({ searches, tokenCoverageFilter }) {
  const hasSearches = Array.isArray(searches) && searches.length > 0;

  if (!hasSearches && !tokenCoverageFilter) {
    return null;
  }

  return (
    <div className={styles.searchExecutionList}>
      <ToolTokenCoverageSummary tokenCoverageFilter={tokenCoverageFilter} />
      {searches.map((search, index) => (
        <div key={`${search.kind || "search"}-${index}`} className={styles.searchExecutionCard}>
          <div className={styles.searchExecutionHeader}>
            <span className={styles.searchExecutionKind}>{search.kind || "search"}</span>
            <span className={styles.searchExecutionMeta}>
              mode {search.searchMode || "n/a"} · {Number(search.resultCount ?? 0)} result{Number(search.resultCount ?? 0) === 1 ? "" : "s"}
            </span>
          </div>
          <p className={styles.searchExecutionQuery}>{String(search.query ?? "") || "n/a"}</p>
        </div>
      ))}
    </div>
  );
}

function hasToolSearchResult(toolCall) {
  const searchResult = toolCall?.searchResult;

  if (!searchResult || typeof searchResult !== "object") {
    return false;
  }

  if (Array.isArray(searchResult)) {
    return searchResult.length > 0;
  }

  return Object.values(searchResult).some((value) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }

    return value !== null && value !== undefined;
  });
}

function areDebugValuesEquivalent(leftValue, rightValue) {
  if (leftValue === rightValue) {
    return true;
  }

  if (leftValue === null || leftValue === undefined || rightValue === null || rightValue === undefined) {
    return false;
  }

  try {
    return JSON.stringify(leftValue) === JSON.stringify(rightValue);
  } catch {
    return false;
  }
}

function ExecutionTimingSummary({ timings, toolCalls }) {
  if (!timings || typeof timings !== "object") {
    return <p className={styles.sectionEmpty}>No timing data was recorded for this turn.</p>;
  }

  const orderedEntries = buildTimingDebugEntries({ timings, toolCalls });
  const timingDebugJson = buildTimingDebugJson({ timings, toolCalls, orderedEntries });

  return (
    <div className={styles.searchExecutionList}>
      <div className={styles.searchExecutionCard}>
        <div className={styles.searchExecutionHeader}>
          <span className={styles.searchExecutionKind}>request</span>
          <span className={styles.searchExecutionMeta}>total {formatDuration(timings.totalDurationMs)}</span>
        </div>
        <p className={styles.searchExecutionQuery}>
          {formatTimestamp(timings.requestStartedAt)} to {formatTimestamp(timings.requestCompletedAt)}
        </p>
      </div>

      {orderedEntries.map((entry) => (
        <div key={entry.key} className={styles.searchExecutionCard}>
          <div className={styles.searchExecutionHeader}>
            <span className={styles.searchExecutionKind}>{entry.label}</span>
            <span className={styles.searchExecutionMeta}>{formatDuration(entry.durationMs)}</span>
          </div>
          <p className={styles.searchExecutionQuery}>
            {formatTimestamp(entry.startedAt)} to {formatTimestamp(entry.completedAt)}
            {entry.meta ? ` · ${entry.meta}` : ""}
          </p>
        </div>
      ))}

      <details className={styles.debugDetail}>
        <summary>Raw timing JSON</summary>
        <pre className={styles.jsonBlock}>{formatJson(timingDebugJson)}</pre>
      </details>
    </div>
  );
}

function getTurnToolBadgeState(turn) {
  const toolInvocations = Array.isArray(turn?.toolInvocations) ? turn.toolInvocations : [];
  const knowledgeMode = String(turn?.knowledgeMode ?? KNOWLEDGE_MODE_GROUNDED).trim() || KNOWLEDGE_MODE_GROUNDED;
  const invokedTools = Array.from(new Set(
    toolInvocations
      .map((invocation) => String(invocation?.toolName ?? "").trim())
      .filter(Boolean),
  ));
  const toolsWithResults = Array.from(new Set(
    toolInvocations
      .filter((invocation) => Number(invocation?.resultCount ?? 0) > 0)
      .map((invocation) => String(invocation?.toolName ?? "").trim())
      .filter(Boolean),
  ));
  if (invokedTools.length > 0) {
    const hasToolResults = toolsWithResults.length > 0;
    const statusLabel = hasToolResults
      ? (knowledgeMode === KNOWLEDGE_MODE_BROAD ? "BROAD MODE" : "GROUNDED MODE")
      : "NO TOOL RESULT";

    return {
      toolLabels: invokedTools.map((toolName) => `TOOL: ${toolName}`),
      addTargets: [],
      statusLabel,
    };
  }

  return {
    toolLabels: [],
    addTargets: [],
    statusLabel: knowledgeMode === KNOWLEDGE_MODE_BROAD ? "BROAD MODE" : "NO TOOL USED",
  };
}

function TurnDebugPanel({ turn }) {
  if (!turn) {
    return (
      <div className={styles.debugEmptyState}>
        <h2>Select a turn</h2>
        <p>Send a message to inspect the query, tool activity, curated agent input, and final model output.</p>
      </div>
    );
  }

  if (turn.isPending) {
    return (
      <div className={styles.debugEmptyState}>
        <h2>Waiting for response</h2>
        <p>Debug details will appear here after the current turn finishes.</p>
      </div>
    );
  }

  if (turn.error) {
    return (
      <div className={styles.debugEmptyState}>
        <h2>Turn failed</h2>
        <p>Error details are not shown in the debug panel.</p>
        <p>Use application logs for failure diagnostics.</p>
      </div>
    );
  }

  if (!turn.debug) {
    return (
      <div className={styles.debugEmptyState}>
        <h2>Debug unavailable</h2>
        <p>This response did not include debug data. Check the server-side debug setting if you want this panel populated.</p>
      </div>
    );
  }

  const toolCalls = Array.isArray(turn.debug.toolCalls) ? turn.debug.toolCalls : [];
  const timings = turn?.debug?.timings;
  const turnClassification = turn?.debug?.turnClassification;
  const knowledgeMode = String(turn?.knowledgeMode ?? turn?.familyPayload?.knowledgeMode ?? KNOWLEDGE_MODE_GROUNDED).trim() || KNOWLEDGE_MODE_GROUNDED;
  const visibilityScope = turn?.familyPayload?.visibilityScope ?? turn?.debug?.family?.visibilityScope ?? null;
  const turnClassificationDebug = visibilityScope && typeof visibilityScope === "object"
    ? {
      ...(turnClassification && typeof turnClassification === "object" ? turnClassification : {}),
      visibilityScope,
    }
    : turnClassification;
  const debugUserQuery = {
    knowledgeMode,
    ...(turn.debug.userQuery && typeof turn.debug.userQuery === "object" ? turn.debug.userQuery : {}),
  };

  return (
    <div className={styles.debugSections}>
      <section className={styles.debugSection}>
        <div className={styles.sectionHeader}>
          <p className="appSectionEyebrow">1. User Query</p>
          <h2 className={styles.sectionTitle}>Conversation input</h2>
        </div>
        <pre className={styles.jsonBlock}>{formatJson(debugUserQuery)}</pre>
      </section>

      <section className={styles.debugSection}>
        <div className={styles.sectionHeader}>
          <p className="appSectionEyebrow">2. Turn Classification</p>
          <h2 className={styles.sectionTitle}>Shared grounded-vs-broader decision</h2>
        </div>
        <pre className={styles.jsonBlock}>{formatJson(turnClassificationDebug)}</pre>
      </section>

      <section className={styles.debugSection}>
        <div className={styles.sectionHeader}>
          <p className="appSectionEyebrow">3. Execution Timing</p>
          <h2 className={styles.sectionTitle}>Where the time went</h2>
        </div>
        <ExecutionTimingSummary timings={timings} toolCalls={toolCalls} />
      </section>

      <section className={styles.debugSection}>
        <div className={styles.sectionHeader}>
          <p className="appSectionEyebrow">4. Tool Calls</p>
          <h2 className={styles.sectionTitle}>{toolCalls.length} invocation{toolCalls.length === 1 ? "" : "s"}</h2>
        </div>
        {toolCalls.length === 0 ? (
          <p className={styles.sectionEmpty}>No tool calls were recorded for this turn.</p>
        ) : (
          <div className={styles.toolCallList}>
            {toolCalls.map((toolCall) => {
              const hasSearchResult = hasToolSearchResult(toolCall);
              const shouldShowActualSearchResults = hasSearchResult
                && !areDebugValuesEquivalent(toolCall.searchResult, toolCall.toolDebug);

              return (
                <article key={toolCall.callId || `${toolCall.round}-${toolCall.toolName}`} className={styles.toolCard}>
                  <div className={styles.toolHeader}>
                    <div>
                      <p className={styles.toolLabel}>Tool cycle {toolCall.round}</p>
                      <h3 className={styles.toolName}>{toolCall.toolName || "Tool call"}</h3>
                      <p className={styles.debugMetaText}>
                        {formatTimestamp(toolCall.startedAt)} to {formatTimestamp(toolCall.completedAt)} · {formatDuration(toolCall.durationMs)}
                      </p>
                    </div>
                    {toolCall.error ? <span className={styles.toolErrorBadge}>Error</span> : null}
                  </div>

                  <details className={styles.debugDetail}>
                    <summary>Parsed arguments</summary>
                    <pre className={styles.jsonBlock}>{formatJson(toolCall.parsedArguments)}</pre>
                  </details>

                  {(Array.isArray(toolCall.searchResult?.searches) && toolCall.searchResult.searches.length > 0)
                    || toolCall.searchResult?.tokenCoverageFilter ? (
                      <details className={styles.debugDetail} open>
                        <summary>Search execution</summary>
                        <ToolSearchExecutionSummary
                          searches={toolCall.searchResult.searches}
                          tokenCoverageFilter={toolCall.searchResult.tokenCoverageFilter}
                        />
                      </details>
                    ) : null}

                  {shouldShowActualSearchResults ? (
                    <details className={styles.debugDetail}>
                      <summary>Actual search results</summary>
                      <pre className={styles.jsonBlock}>{formatJson(toolCall.searchResult)}</pre>
                    </details>
                  ) : null}

                  <details className={styles.debugDetail}>
                    <summary>Tool output</summary>
                    <pre className={styles.jsonBlock}>{formatJson(toolCall.toolOutput)}</pre>
                  </details>

                  {toolCall.toolDebug ? (
                    <details className={styles.debugDetail}>
                      <summary>Tool debug</summary>
                      <pre className={styles.jsonBlock}>{formatJson(toolCall.toolDebug)}</pre>
                    </details>
                  ) : null}

                  {toolCall.toolMetaData ? (
                    <details className={styles.debugDetail}>
                      <summary>Tool meta data</summary>
                      <pre className={styles.jsonBlock}>{formatJson(toolCall.toolMetaData)}</pre>
                    </details>
                  ) : null}

                  {toolCall.error ? (
                    <details className={styles.debugDetail} open>
                      <summary>Tool error</summary>
                      <pre className={styles.jsonBlock}>{formatJson(toolCall.error)}</pre>
                    </details>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className={styles.debugSection}>
        <div className={styles.sectionHeader}>
          <p className="appSectionEyebrow">5. Curated Agent Input</p>
          <h2 className={styles.sectionTitle}>Messages passed back to the model</h2>
        </div>
        <pre className={styles.jsonBlock}>{formatJson(turn.debug.curatedAgentInput)}</pre>
      </section>

      <section className={styles.debugSection}>
        <div className={styles.sectionHeader}>
          <p className="appSectionEyebrow">6. Agent Output</p>
          <h2 className={styles.sectionTitle}>Model response and answer</h2>
        </div>
        <pre className={styles.jsonBlock}>{formatJson(turn.debug.agentOutput)}</pre>
      </section>
    </div>
  );
}

export default function ChatPageClient({ includeDebug }) {
  const { user } = useAuth();
  const userMessageLabel = buildUserMessageLabel(user);
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedVisibilityParam = searchParams.get("visibility");
  const requestedFamilyParam = searchParams.get("family");
  const {
    visibility,
    isReady: isVisibilityReady,
    setVisibility,
  } = usePersistedVisibility({
    requestedVisibility: requestedVisibilityParam,
    allowedValues: ALL_VISIBILITY_VALUES,
    defaultValue: DEFAULT_CHAT_VISIBILITY,
  });
  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState([]);
  const [selectedTurnId, setSelectedTurnId] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [requestError, setRequestError] = useState(null);
  const [availableChatFamilies, setAvailableChatFamilies] = useState([]);
  const [chatFamily, setChatFamily] = useState(null);
  const chatFeedRef = useRef(null);
  const defaultChatFamily = resolvePreferredDefaultChatFamily(availableChatFamilies);

  const selectedTurn = turns.find((turn) => turn.id === selectedTurnId) ?? turns.at(-1) ?? null;
  const displayedTurns = [...turns].reverse();
  const hasObservedDebugData = turns.some((turn) => turn?.debug !== null && turn?.debug !== undefined);
  const showTurnInspector = includeDebug || hasObservedDebugData;
  const isSingleTurnLayout = turns.length === 1;
  const isInitialTransientState = turns.length === 1 && (Boolean(turns[0]?.isPending) || Boolean(turns[0]?.error));
  const isHistoryEmpty = turns.length === 0;
  const isDebugPending = showTurnInspector && Boolean(selectedTurn?.isPending);
  const isDebugEmpty = showTurnInspector && !selectedTurn;
  const isDebugCompactState = isDebugEmpty || isDebugPending;
  const shouldShowVisibilityControl = chatFamily === "knowledgeTrees";

  const loadAvailableFamilies = async () => {
    const payload = await fetchAvailableChatFamilies();
    const nextFamilies = Array.isArray(payload?.families) ? payload.families : [];
    const nextDefaultFamily = resolvePreferredDefaultChatFamily(nextFamilies, payload?.defaultFamily);

    setAvailableChatFamilies(nextFamilies);
    setChatFamily((currentFamily) => normalizeChatFamilySelection(
      requestedFamilyParam || currentFamily,
      nextFamilies,
      nextDefaultFamily,
    ));
  };

  const handleVisibilityChange = (event) => {
    const nextVisibility = setVisibility(event.target.value);
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    setVisibilitySearchParam(nextSearchParams, nextVisibility, ALL_VISIBILITY_VALUES);
    const nextQueryString = nextSearchParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  };

  const handleChatFamilyChange = (event) => {
    const nextFamily = normalizeChatFamilySelection(event.target.value, availableChatFamilies, defaultChatFamily);
    setChatFamily(nextFamily);
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    setChatFamilySearchParam(nextSearchParams, nextFamily, availableChatFamilies, defaultChatFamily);
    const nextQueryString = nextSearchParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  };

  useEffect(() => {
    let isCancelled = false;

    fetchAvailableChatFamilies()
      .then((payload) => {
        if (isCancelled) {
          return;
        }

        const nextFamilies = Array.isArray(payload?.families) ? payload.families : [];
        const nextDefaultFamily = resolvePreferredDefaultChatFamily(nextFamilies, payload?.defaultFamily);

        setAvailableChatFamilies(nextFamilies);
        setChatFamily((currentFamily) => normalizeChatFamilySelection(
          requestedFamilyParam || currentFamily,
          nextFamilies,
          nextDefaultFamily,
        ));
      })
      .catch((error) => {
        if (isCancelled) {
          return;
        }

        console.error("Chat family load failed:", error);
        setAvailableChatFamilies([]);
        setChatFamily(null);
      });

    return () => {
      isCancelled = true;
    };
  }, [requestedFamilyParam]);

  useEffect(() => {
    if (!isVisibilityReady) {
      return;
    }

    if (requestedVisibilityParam === visibility) {
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    setVisibilitySearchParam(nextSearchParams, visibility, ALL_VISIBILITY_VALUES);
    const currentQueryString = searchParams.toString();
    const nextQueryString = nextSearchParams.toString();

    if (nextQueryString === currentQueryString) {
      return;
    }

    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  }, [isVisibilityReady, pathname, requestedVisibilityParam, router, searchParams, visibility]);

  useEffect(() => {
    if (availableChatFamilies.length === 0) {
      if (chatFamily !== null) {
        Promise.resolve().then(() => {
          setChatFamily(null);
        });
      }
      return;
    }

    const normalizedRequestedFamily = normalizeChatFamilySelection(requestedFamilyParam, availableChatFamilies, defaultChatFamily);

    if (chatFamily !== normalizedRequestedFamily) {
      Promise.resolve().then(() => {
        setChatFamily(normalizedRequestedFamily);
      });
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    setChatFamilySearchParam(nextSearchParams, chatFamily, availableChatFamilies, defaultChatFamily);
    const currentQueryString = searchParams.toString();
    const nextQueryString = nextSearchParams.toString();

    if (nextQueryString === currentQueryString) {
      return;
    }

    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  }, [availableChatFamilies, chatFamily, defaultChatFamily, pathname, requestedFamilyParam, router, searchParams]);

  async function submitTurn({ question, message }) {
    const turnId = createTurnId();
    const history = buildHistoryFromTurns(turns);
    const requestId = createRequestId();
    const requestStartedAt = new Date().toISOString();

    setIsSubmitting(true);
    setRequestError(null);
    setSelectedTurnId(turnId);
    setTurns((currentTurns) => ([
      ...currentTurns,
      {
        id: turnId,
        question,
        originalQuestion: question,
        answer: "",
        debug: null,
        error: null,
        familyPayload: null,
        citations: [],
        toolsUsed: [],
        toolInvocations: [],
        knowledgeMode: KNOWLEDGE_MODE_GROUNDED,
        isPersistenceOffer: false,
        isPermissionToBroadenRequest: false,
        createdAt: Date.now(),
        isPending: true,
      },
    ]));

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-chat-request-id": requestId,
        },
        body: JSON.stringify({
          message,
          history,
          family: chatFamily,
          visibility,
        }),
      });

      const payload = await parseApiResponseBody(response);

      if (!response.ok) {
        throw {
          message: payload?.error || `Chat request failed (${response.status})`,
          debug: null,
        };
      }
      setTurns((currentTurns) => currentTurns.map((turn) => (
        turn.id === turnId
          ? {
            ...turn,
            answer: String(payload?.answer ?? "").trim(),
            debug: payload?.debug ?? null,
            familyPayload: payload?.familyPayload ?? null,
            citations: Array.isArray(payload?.citations) ? payload.citations : [],
            toolsUsed: Array.isArray(payload?.toolsUsed) ? payload.toolsUsed : [],
            toolInvocations: Array.isArray(payload?.toolInvocations) ? payload.toolInvocations : [],
            knowledgeMode: String(payload?.knowledgeMode ?? payload?.familyPayload?.knowledgeMode ?? KNOWLEDGE_MODE_GROUNDED).trim() || KNOWLEDGE_MODE_GROUNDED,
            isPersistenceOffer: payload?.isPersistenceOffer === true,
            isPermissionToBroadenRequest: payload?.isPermissionToBroadenRequest === true,
            originalQuestion: turn.originalQuestion,
            error: null,
            isPending: false,
          }
          : turn
      )));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error?.message || "Chat request failed");

      setRequestError(messageText);
      setTurns((currentTurns) => currentTurns.map((turn) => (
        turn.id === turnId
          ? {
            ...turn,
            answer: "",
            debug: null,
            error: messageText,
            familyPayload: null,
            toolInvocations: [],
            knowledgeMode: KNOWLEDGE_MODE_GROUNDED,
            isPersistenceOffer: false,
            isPermissionToBroadenRequest: false,
            isPending: false,
          }
          : turn
      )));
    } finally {
      setIsSubmitting(false);
    }
  }

  useEffect(() => {
    if (!chatFeedRef.current) {
      return;
    }

    chatFeedRef.current.scrollTop = chatFeedRef.current.scrollHeight;
  }, [turns, isSubmitting]);

  async function handleSubmit(event) {
    event.preventDefault();

    const message = prompt.trim();

    if (!message || isSubmitting || !isVisibilityReady || !chatFamily) {
      return;
    }

    setPrompt("");
    await submitTurn({
      question: message,
      message,
    });
  }

  function handlePromptKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent?.isComposing) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <main className="appPageShell">
      <section className={`${styles.workspaceGrid} ${!showTurnInspector ? styles.workspaceGridSingle : ""}`}>
        <div className={styles.chatColumnStack}>
          <div className={styles.chatColumnSurface}>
            <section className={styles.heroCard}>
            <div className={`appPanelTopBar ${styles.promptPanelHeader}`}>
              <p className="appEyebrow">Prompt</p>
              <label className={styles.toolbarLabel}>
                <select
                  value={chatFamily ?? ""}
                  onChange={handleChatFamilyChange}
                  disabled={isSubmitting || availableChatFamilies.length === 0}
                >
                  {availableChatFamilies.length === 0 ? (
                    <option value="" disabled>No families available</option>
                  ) : null}
                  {availableChatFamilies.map((family) => (
                    <option key={family.family} value={family.family}>{family.label || family.family}</option>
                  ))}
                </select>
              </label>
              {shouldShowVisibilityControl ? (
                <label className={styles.toolbarLabel}>
                  <select
                    value={visibility}
                    onChange={handleVisibilityChange}
                    disabled={isSubmitting || !isVisibilityReady}
                  >
                    <option value="public">Public</option>
                    <option value="private">Private</option>
                    <option value="both">Both</option>
                  </select>
                </label>
              ) : null}
              <button
                type="submit"
                form="chat-prompt-form"
                className={`appCompactActionButton appCompactActionButtonNeutral ${styles.promptToolbarButton}`}
                disabled={isSubmitting || !prompt.trim() || !isVisibilityReady || !chatFamily}
              >
                {isSubmitting ? "Thinking..." : "Send"}
              </button>
            </div>
            <form id="chat-prompt-form" onSubmit={handleSubmit} className={styles.composerForm}>
              <label className={styles.composerField}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={handlePromptKeyDown}
                  placeholder={buildChatPlaceholder(availableChatFamilies)}
                  className={styles.textArea}
                  rows={4}
                  disabled={availableChatFamilies.length === 0}
                />
              </label>
            </form>
            </section>

            {requestError ? <p className={`${styles.errorMessage} ${styles.errorMessageInline}`}>{requestError}</p> : null}

            <div className={`${styles.chatPanel} ${isSingleTurnLayout ? styles.chatPanelSingleTurn : ""} ${isInitialTransientState ? styles.chatPanelInitialPending : ""} ${isHistoryEmpty ? styles.chatPanelEmpty : ""}`}>
              <div ref={chatFeedRef} className={`${styles.chatFeed} ${isSingleTurnLayout ? styles.chatFeedSingleTurn : ""} ${isInitialTransientState ? styles.chatFeedInitialPending : ""} ${isHistoryEmpty ? styles.chatFeedEmpty : ""}`}>
              {turns.length === 0 ? (
                <div className={`${styles.emptyState} ${styles.emptyStateCompact}`}>
                  <h3>Start a turn</h3>
                  <p>
                    {showTurnInspector
                      ? "This will show the conversation."
                      : "The conversation history and grounded citations will appear here as you ask questions."}
                  </p>
                </div>
              ) : (
                displayedTurns.map((turn) => {
                  const isSelected = turn.id === selectedTurn?.id;
                  const toolBadgeState = getTurnToolBadgeState(turn);
                  const isCompactTurnState = turn.isPending || Boolean(turn.error);

                  return (
                    <article
                      key={turn.id}
                      className={`${styles.turnCard} ${isCompactTurnState ? styles.turnCardPending : ""} ${isSelected ? styles.turnCardSelected : ""}`}
                      onClick={() => setSelectedTurnId(turn.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedTurnId(turn.id);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <div className={styles.turnMetaRow}>
                        <span className={styles.turnTimestamp}>{formatTimestamp(turn.createdAt)}</span>
                        <span className={styles.turnStatus}>{turn.isPending ? "Pending" : turn.error ? "Error" : "Complete"}</span>
                      </div>

                      {!turn.isPending && !turn.error ? (
                        <div className={styles.toolChipRow}>
                          {toolBadgeState.toolLabels.map((label) => (
                            <span key={`${turn.id}-${label}`} className={styles.toolChip}>{label}</span>
                          ))}
                          {toolBadgeState.statusLabel ? (
                            <span className={styles.noToolChip}>{toolBadgeState.statusLabel}</span>
                          ) : null}
                        </div>
                      ) : null}

                      <div className={`${styles.messageBubbleAgent} ${isCompactTurnState ? styles.messageBubblePending : ""} ${turn.isPending ? styles.messageBubbleAgentThinking : ""}`}>
                        <div className={styles.messageHeaderRow}>
                          <p className={styles.messageLabel}>Agent</p>
                        </div>
                        <div className={styles.messageContent}>
                          {turn.isPending ? (
                            <p className={`${styles.messageText} ${isCompactTurnState ? styles.messageTextPending : ""} ${turn.isPending ? styles.messageTextThinking : ""}`}>
                              Waiting for response...
                            </p>
                          ) : turn.error ? (
                            <p className={`${styles.messageText} ${isCompactTurnState ? styles.messageTextPending : ""}`}>
                              {turn.error}
                            </p>
                          ) : (
                            <AgentAnswerContent
                              answer={turn.answer || "No answer returned."}
                              keyPrefix={`${turn.id}-answer`}
                              textClassName={`${styles.messageText} ${isCompactTurnState ? styles.messageTextPending : ""}`}
                            />
                          )}
                        </div>
                      </div>

                      <div className={`${styles.messageBubbleUser} ${isCompactTurnState ? styles.messageBubblePending : ""}`}>
                        <p className={styles.messageLabel}>{userMessageLabel}</p>
                        <p className={`${styles.messageText} ${isCompactTurnState ? styles.messageTextPending : ""}`}>{turn.question}</p>
                      </div>

                      {!turn.isPending && !turn.error ? <CitationBreadcrumbs citations={turn.citations} visibility={visibility} /> : null}
                    </article>
                  );
                })
              )}
              </div>
            </div>
          </div>

        </div>

        {showTurnInspector ? (
          <aside className={`appPanelShell ${styles.debugPanel} ${isDebugCompactState ? styles.debugPanelEmpty : ""}`}>
            <div className={`appPanelTopBar ${styles.panelHeader}`}>
              <div>
                <p className="appEyebrow">Turn inspector</p>
              </div>
            </div>
            <div className={`${styles.debugBody} ${isDebugCompactState ? styles.debugBodyEmpty : ""}`}>
              {!isDebugPending ? (
                <p className={styles.debugIntro}>
                  Inspect exactly how the agent searched, curated evidence, and produced the answer.
                </p>
              ) : null}
              <TurnDebugPanel turn={selectedTurn} />
            </div>
          </aside>
        ) : null}
      </section>
    </main>
  );
}