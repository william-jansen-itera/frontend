"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/app/useAuth";
import { hasClientPrincipalRole } from "@/shared/clientPrincipal";
import styles from "./page.module.css";
import {
  ALL_VISIBILITY_VALUES,
  buildVisibilityHref,
  PUBLIC_PRIVATE_VISIBILITY_VALUES,
  setVisibilitySearchParam,
  usePersistedVisibility,
} from "../usePersistedVisibility";

const TURN_TYPE_NO_RESULT_OFFER = "no_result_offer_broadening";
const TURN_TYPE_BROADER_ANSWER = "broader_answer";
const IMAGE_FILE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
const CHAT_FAMILY_OPTIONS = ["treeGrounding", "investment"];
const DEFAULT_CHAT_FAMILY = "treeGrounding";
const CHAT_FAMILY_LABELS = Object.freeze({
  treeGrounding: "trees and attachments",
  investment: "investments",
});

function normalizeChatFamily(value) {
  const normalizedValue = String(value ?? "").trim();

  return CHAT_FAMILY_OPTIONS.includes(normalizedValue) ? normalizedValue : DEFAULT_CHAT_FAMILY;
}

function buildChatPlaceholder() {
  const familyLabels = CHAT_FAMILY_OPTIONS
    .map((family) => CHAT_FAMILY_LABELS[family])
    .filter(Boolean);

  if (familyLabels.length === 0) {
    return "Ask the agent a question";
  }

  if (familyLabels.length === 1) {
    return `Ask the agent about ${familyLabels[0]}`;
  }

  const leadingLabels = familyLabels.slice(0, -1).join(", ");
  const trailingLabel = familyLabels[familyLabels.length - 1];

  return `Ask the agent about ${leadingLabels}, or ${trailingLabel}`;
}

function setChatFamilySearchParam(searchParams, family) {
  const normalizedFamily = normalizeChatFamily(family);

  if (normalizedFamily === DEFAULT_CHAT_FAMILY) {
    searchParams.delete("family");
    return;
  }

  searchParams.set("family", normalizedFamily);
}

function getImageExtension(candidate) {
  const normalizedCandidate = String(candidate ?? "").trim().toLowerCase();

  if (!normalizedCandidate) {
    return "";
  }

  const sanitizedCandidate = normalizedCandidate.split("?")[0].split("#")[0];

  if (!sanitizedCandidate.includes(".")) {
    return "";
  }

  return sanitizedCandidate.slice(sanitizedCandidate.lastIndexOf(".") + 1);
}

function isImageUrlCandidate(candidate) {
  return IMAGE_FILE_EXTENSIONS.has(getImageExtension(candidate));
}

function getInternalAttachmentContentUrl(rawUrl) {
  try {
    const parsedUrl = new URL(String(rawUrl ?? ""));
    const pathSegments = parsedUrl.pathname.split("/").map((part) => part.trim()).filter(Boolean);

    if (!parsedUrl.hostname.endsWith(".blob.core.windows.net")) {
      return null;
    }

    if (pathSegments[0] !== "node-attachments" || pathSegments.length < 2) {
      return null;
    }

    const blobName = pathSegments.slice(1).join("/");

    if (!blobName) {
      return null;
    }

    return `/api/attachments/content?blobName=${encodeURIComponent(blobName)}`;
  } catch {
    return null;
  }
}

function getAttachmentFileNameFromUrl(rawUrl) {
  try {
    const parsedUrl = new URL(String(rawUrl ?? ""));
    const pathSegments = parsedUrl.pathname.split("/").map((part) => part.trim()).filter(Boolean);
    return pathSegments[pathSegments.length - 1] || "Attachment preview";
  } catch {
    return "Attachment preview";
  }
}

function buildAgentAnswerBlocks(answer) {
  const normalizedAnswer = String(answer ?? "");
  const imagePattern = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
  const blocks = [];
  let cursor = 0;
  let match = imagePattern.exec(normalizedAnswer);

  while (match) {
    const [fullMatch, altText, imageUrl] = match;
    const contentUrl = getInternalAttachmentContentUrl(imageUrl);

    if (contentUrl && isImageUrlCandidate(imageUrl)) {
      const textBefore = normalizedAnswer.slice(cursor, match.index);

      if (textBefore.trim()) {
        blocks.push({
          type: "text",
          content: textBefore,
        });
      }

      blocks.push({
        type: "image",
        alt: String(altText ?? "").trim() || "Attachment preview",
        src: contentUrl,
        fileName: getAttachmentFileNameFromUrl(imageUrl),
      });
      cursor = match.index + fullMatch.length;
    }

    match = imagePattern.exec(normalizedAnswer);
  }

  const trailingText = normalizedAnswer.slice(cursor);

  if (trailingText.trim()) {
    blocks.push({
      type: "text",
      content: trailingText,
    });
  }

  return blocks.length > 0 ? blocks : [{ type: "text", content: normalizedAnswer }];
}

function renderAgentAnswerContent(answer, keyPrefix, textClassName) {
  return buildAgentAnswerBlocks(answer).map((block, index) => {
    if (block.type === "image") {
      return (
        <div key={`${keyPrefix}-image-${index}`} className={styles.attachmentPreviewRow}>
          <div className={styles.attachmentPreviewDetails}>
            <span className={styles.attachmentPreviewFileName}>{block.alt}</span>
          </div>
          <div className={styles.attachmentPreviewFrame}>
            <Image
              src={block.src}
              alt={block.alt}
              width={240}
              height={180}
              sizes="240px"
              className={styles.attachmentPreviewImage}
              unoptimized
            />
          </div>
          <a
            href={block.src}
            target="_blank"
            rel="noreferrer"
            className={styles.attachmentOpenLink}
          >
            Open
          </a>
        </div>
      );
    }

    return (
      <p key={`${keyPrefix}-text-${index}`} className={textClassName}>
        {block.content}
      </p>
    );
  });
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

function buildFollowUpSubmissionMessage(optionId, fallbackLabel) {
  if (optionId === TURN_TYPE_BROADER_ANSWER) {
    return "Use broader knowledge";
  }

  return fallbackLabel;
}

function parseToolTreeId(toolName) {
  const match = String(toolName ?? "").trim().match(/_(\d+)$/);
  return match ? match[1] : "";
}

function getLatestBroaderAnswerClarificationTurn(turns) {
  const latestTurn = turns.at(-1) ?? null;

  if (!latestTurn || latestTurn.isPending || latestTurn.error) {
    return null;
  }

  if (latestTurn.turnType !== TURN_TYPE_BROADER_ANSWER) {
    return null;
  }

  const priorToolInvocations = Array.isArray(latestTurn.priorToolInvocations) ? latestTurn.priorToolInvocations : [];
  const toolInvocations = Array.isArray(latestTurn.toolInvocations) ? latestTurn.toolInvocations : [];

  if (toolInvocations.length > 0) {
    return null;
  }

  if (priorToolInvocations.length === 0) {
    return null;
  }

  return latestTurn;
}

function buildImplicitBroaderFollowUpSelection(turn, message) {
  if (!turn) {
    return null;
  }

  const normalizedMessage = String(message ?? "").trim();

  if (!normalizedMessage) {
    return null;
  }

  const sourceToolInvocations = (
    Array.isArray(turn.priorToolInvocations) && turn.priorToolInvocations.length > 0
      ? turn.priorToolInvocations
      : Array.isArray(turn.toolInvocations)
        ? turn.toolInvocations
        : []
  ).map((invocation) => ({
    toolName: invocation?.toolName,
    resultCount: invocation?.resultCount,
  }));

  if (sourceToolInvocations.length === 0) {
    return null;
  }

  return {
    sourceTurnId: turn.id,
    optionId: TURN_TYPE_BROADER_ANSWER,
    sourceQuestion: String(turn.originalQuestion ?? turn.question ?? "").trim(),
    sourceToolInvocations,
  };
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

async function fetchAgentFamilyManagementState() {
  const response = await fetch("/api/admin/agents", { cache: "no-store" });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error || "Agent families could not be loaded");
  }

  return Array.isArray(payload?.families) ? payload.families : [];
}

function getFamilyStatusClassName(stylesheet, promptAgentStatus) {
  switch (String(promptAgentStatus ?? "").trim()) {
    case "published":
      return stylesheet.agentFamilyStatusPublished;
    case "not_published":
      return stylesheet.agentFamilyStatusUnknown;
    case "publishing":
    case "pending":
      return stylesheet.agentFamilyStatusPending;
    case "unsupported":
      return stylesheet.agentFamilyStatusUnsupported;
    case "status_error":
    case "error":
      return stylesheet.agentFamilyStatusError;
    default:
      return stylesheet.agentFamilyStatusUnknown;
  }
}

function formatFamilyPromptAgentStatus(promptAgentStatus) {
  switch (String(promptAgentStatus ?? "").trim()) {
    case "published":
      return "Published";
    case "not_published":
      return "Not published";
    case "publishing":
    case "pending":
      return "Publishing";
    case "unsupported":
      return "Unsupported";
    case "status_error":
    case "error":
      return "Status error";
    default:
      return "Unknown";
  }
}

function buildFamilyPublishLabel(family) {
  return String(family?.promptAgentStatus ?? "").trim() === "published" ? "Re-publish" : "Publish";
}

function formatFamilyPublishMessage(family, publishStatus) {
  const familyLabel = String(family?.label ?? family?.family ?? "This family").trim();
  const promptAgentName = String(publishStatus?.promptAgentName ?? family?.promptAgentName ?? "").trim();
  const publishedAt = publishStatus?.lastPublishedAt ?? family?.lastPublishedAt ?? null;
  const publishedSuffix = publishedAt ? ` at ${formatDateTimeTimestamp(publishedAt)}` : "";

  return promptAgentName
    ? `${familyLabel} prompt agent published as ${promptAgentName}${publishedSuffix}.`
    : `${familyLabel} prompt agent published${publishedSuffix}.`;
}

function formatFamilyLastPublished(family) {
  const promptAgentStatus = String(family?.promptAgentStatus ?? "").trim();

  if (family?.lastPublishedAt) {
    return formatDateTimeTimestamp(family.lastPublishedAt);
  }

  switch (promptAgentStatus) {
    case "not_published":
      return "Never";
    case "unsupported":
      return "Not applicable";
    case "published":
      return "Unavailable";
    case "status_error":
    case "error":
      return "Unknown";
    default:
      return "Unknown";
  }
}

function getFamilyDefinedTools(family) {
  if (!Array.isArray(family?.tools)) {
    return [];
  }

  return family.tools.filter((tool) => tool && (tool.name || tool.description));
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
  const buildNotesHref = (nodeId) => {
    const notesSearchParams = new URLSearchParams();
    notesSearchParams.set("treeId", String(citation.treeId));
    notesSearchParams.set("nodeId", String(nodeId));
    return buildVisibilityHref("/notes", notesSearchParams.toString(), visibility, PUBLIC_PRIVATE_VISIBILITY_VALUES);
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
  const priorToolInvocations = Array.isArray(turn?.priorToolInvocations) ? turn.priorToolInvocations : [];
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
  const isBroaderAnswerTurn = turn?.turnType === TURN_TYPE_BROADER_ANSWER;
  const priorTools = Array.from(new Set(
    priorToolInvocations
      .map((invocation) => String(invocation?.toolName ?? "").trim())
      .filter(Boolean),
  ));

  if (invokedTools.length > 0) {
    const hasToolResults = toolsWithResults.length > 0;
    const shouldHighlightAddTarget = isBroaderAnswerTurn && !hasToolResults;

    return {
      toolLabels: invokedTools.map((toolName) => `TOOL: ${toolName}`),
      addTargets: shouldHighlightAddTarget ? invokedTools.map((toolName) => ({
        toolName,
        label: `Add to: ${toolName}`,
      })) : [],
      statusLabel: hasToolResults ? null : "NO TOOL RESULT",
    };
  }

  if (isBroaderAnswerTurn && priorTools.length > 0) {
    return {
      toolLabels: [],
      addTargets: priorTools.map((toolName) => ({
        toolName,
        label: `Add to: ${toolName}`,
      })),
      statusLabel: "NO TOOL USED",
    };
  }

  return {
    toolLabels: [],
    addTargets: [],
    statusLabel: "NO TOOL USED",
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
  const permissionToBroadenDetection = turn?.debug?.agentOutput?.permissionToBroadenDetection;
  const permissionToBroadenSource = String(permissionToBroadenDetection?.source ?? "").trim();
  const turnType = String(turn?.turnType ?? "default").trim() || "default";
  const debugUserQuery = {
    turnType,
    ...(turn.debug.userQuery && typeof turn.debug.userQuery === "object" ? turn.debug.userQuery : {}),
    ...(turnType === TURN_TYPE_NO_RESULT_OFFER && permissionToBroadenSource
      ? { source: permissionToBroadenSource }
      : {}),
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
        <pre className={styles.jsonBlock}>{formatJson(turnClassification)}</pre>
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
            {toolCalls.map((toolCall) => (
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

                <details className={styles.debugDetail}>
                  <summary>Actual search results</summary>
                  <pre className={styles.jsonBlock}>{formatJson(toolCall.searchResult)}</pre>
                </details>

                <details className={styles.debugDetail}>
                  <summary>Tool output</summary>
                  <pre className={styles.jsonBlock}>{formatJson(toolCall.toolOutput)}</pre>
                </details>

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
            ))}
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
        {permissionToBroadenSource ? (
          <details className={styles.debugDetail} open>
            <summary>Permission to broaden detection</summary>
            <pre className={styles.jsonBlock}>{formatJson(permissionToBroadenDetection)}</pre>
          </details>
        ) : null}
        <pre className={styles.jsonBlock}>{formatJson(turn.debug.agentOutput)}</pre>
      </section>
    </div>
  );
}

function getLatestNoResultOfferTurn(turns, dismissedTurnId) {
  const latestTurn = turns.at(-1) ?? null;

  if (!latestTurn || latestTurn.id === dismissedTurnId) {
    return null;
  }

  if (latestTurn.isPending || latestTurn.error) {
    return null;
  }

  if (latestTurn.turnType !== TURN_TYPE_NO_RESULT_OFFER) {
    return null;
  }

  if (!Array.isArray(latestTurn.followUpOptions) || latestTurn.followUpOptions.length === 0) {
    return null;
  }

  return latestTurn;
}

export default function ChatPageClient({ includeDebug }) {
  const { user, isAuthResolved } = useAuth();
  const isAdmin = hasClientPrincipalRole(user, "mdsadmins");
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
  });
  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState([]);
  const [selectedTurnId, setSelectedTurnId] = useState(null);
  const [dismissedFollowUpTurnId, setDismissedFollowUpTurnId] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [requestError, setRequestError] = useState(null);
  const [chatFamily, setChatFamily] = useState(() => normalizeChatFamily(requestedFamilyParam));
  const [addActionState, setAddActionState] = useState(null);
  const [writableTreeIds, setWritableTreeIds] = useState([]);
  const [agentFamilies, setAgentFamilies] = useState([]);
  const [isAgentFamiliesLoading, setIsAgentFamiliesLoading] = useState(false);
  const [agentFamiliesStatusMessage, setAgentFamiliesStatusMessage] = useState("");
  const [agentFamiliesError, setAgentFamiliesError] = useState("");
  const [agentFamilyPendingItems, setAgentFamilyPendingItems] = useState({});
  const chatFeedRef = useRef(null);

  const selectedTurn = turns.find((turn) => turn.id === selectedTurnId) ?? turns.at(-1) ?? null;
  const displayedTurns = [...turns].reverse();
  const activeNoResultOfferTurn = getLatestNoResultOfferTurn(turns, dismissedFollowUpTurnId);
  const activeBroaderAnswerClarificationTurn = getLatestBroaderAnswerClarificationTurn(turns);
  const isPromptInOptionMode = Boolean(activeNoResultOfferTurn);
  const isSingleTurnLayout = turns.length === 1;
  const isInitialTransientState = turns.length === 1 && (Boolean(turns[0]?.isPending) || Boolean(turns[0]?.error));
  const isHistoryEmpty = turns.length === 0;
  const isDebugPending = includeDebug && Boolean(selectedTurn?.isPending);
  const isDebugEmpty = includeDebug && !selectedTurn;
  const isDebugCompactState = isDebugEmpty || isDebugPending;

  const setAgentFamilyPending = (key, isPending) => {
    setAgentFamilyPendingItems((currentState) => ({
      ...currentState,
      [key]: isPending,
    }));
  };

  const loadAgentFamilies = async () => {
    if (!isAdmin) {
      setAgentFamilies([]);
      setIsAgentFamiliesLoading(false);
      return;
    }

    setIsAgentFamiliesLoading(true);

    try {
      const families = await fetchAgentFamilyManagementState();
      setAgentFamilies(families);
      setAgentFamiliesError("");
    } catch (error) {
      setAgentFamilies([]);
      setAgentFamiliesError(getErrorMessage(error, "Agent families could not be loaded"));
    } finally {
      setIsAgentFamiliesLoading(false);
    }
  };

  const handleVisibilityChange = (event) => {
    const nextVisibility = setVisibility(event.target.value);
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    setVisibilitySearchParam(nextSearchParams, nextVisibility, ALL_VISIBILITY_VALUES);
    const nextQueryString = nextSearchParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  };

  const handleChatFamilyChange = (event) => {
    const nextFamily = normalizeChatFamily(event.target.value);
    setChatFamily(nextFamily);
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    setChatFamilySearchParam(nextSearchParams, nextFamily);
    const nextQueryString = nextSearchParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  };

  useEffect(() => {
    if (!isVisibilityReady) {
      return;
    }

    if (!requestedVisibilityParam && visibility === "public") {
      return;
    }

    if (requestedVisibilityParam === visibility) {
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    setVisibilitySearchParam(nextSearchParams, visibility, ALL_VISIBILITY_VALUES);
    const nextQueryString = nextSearchParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  }, [isVisibilityReady, pathname, requestedVisibilityParam, router, searchParams, visibility]);

  useEffect(() => {
    const normalizedRequestedFamily = normalizeChatFamily(requestedFamilyParam);

    if (chatFamily !== normalizedRequestedFamily) {
      setChatFamily(normalizedRequestedFamily);
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    setChatFamilySearchParam(nextSearchParams, chatFamily);
    const currentQueryString = searchParams.toString();
    const nextQueryString = nextSearchParams.toString();

    if (nextQueryString === currentQueryString) {
      return;
    }

    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  }, [chatFamily, pathname, requestedFamilyParam, router, searchParams]);

  useEffect(() => {
    if (!isVisibilityReady) {
      return;
    }

    let isCancelled = false;

    fetch("/api/trees?visibility=both", { cache: "no-store" })
      .then((response) => response.json().then((payload) => ({ ok: response.ok, payload })))
      .then(({ ok, payload }) => {
        if (isCancelled) {
          return;
        }

        if (!ok) {
          throw new Error(payload?.error || "Tree permissions could not be loaded");
        }

        const nextWritableTreeIds = Array.isArray(payload)
          ? payload
            .filter((tree) => Boolean(tree?.currentUserCanWrite))
            .map((tree) => String(tree.id))
          : [];

        setWritableTreeIds(nextWritableTreeIds);
      })
      .catch((error) => {
        if (isCancelled) {
          return;
        }

        console.error("Tree permission load failed:", error);
        setWritableTreeIds([]);
      });

    return () => {
      isCancelled = true;
    };
  }, [isVisibilityReady]);

  useEffect(() => {
    if (!isAuthResolved) {
      return undefined;
    }

    if (!isAdmin) {
      setAgentFamilies([]);
      setAgentFamiliesStatusMessage("");
      setAgentFamiliesError("");
      setIsAgentFamiliesLoading(false);
      return undefined;
    }

    let isCancelled = false;

    setIsAgentFamiliesLoading(true);

    fetchAgentFamilyManagementState()
      .then((families) => {
        if (isCancelled) {
          return;
        }

        setAgentFamilies(families);
        setAgentFamiliesError("");
      })
      .catch((error) => {
        if (isCancelled) {
          return;
        }

        setAgentFamilies([]);
        setAgentFamiliesError(getErrorMessage(error, "Agent families could not be loaded"));
      })
      .finally(() => {
        if (!isCancelled) {
          setIsAgentFamiliesLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [isAdmin, isAuthResolved]);

  const writableTreeIdSet = new Set(writableTreeIds);

  async function submitTurn({ question, message, followUpSelection = null }) {
    const turnId = `${Date.now()}`;
    const history = buildHistoryFromTurns(turns);

    setIsSubmitting(true);
    setRequestError(null);
    setSelectedTurnId(turnId);
    setTurns((currentTurns) => ([
      ...currentTurns,
      {
        id: turnId,
        question,
        originalQuestion: followUpSelection?.sourceQuestion ?? question,
        answer: "",
        debug: null,
        error: null,
        citations: [],
        toolsUsed: [],
        toolInvocations: [],
        priorToolInvocations: [],
        turnType: "default",
        followUpOptions: [],
        createdAt: Date.now(),
        isPending: true,
      },
    ]));

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          history,
          family: chatFamily,
          visibility,
          followUpSelection,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw {
          message: payload?.error || "Chat request failed",
          debug: payload?.debug ?? null,
        };
      }

      setDismissedFollowUpTurnId(null);
      setTurns((currentTurns) => currentTurns.map((turn) => (
        turn.id === turnId
          ? {
            ...turn,
            answer: String(payload?.answer ?? "").trim(),
            debug: payload?.debug ?? null,
            citations: Array.isArray(payload?.citations) ? payload.citations : [],
            toolsUsed: Array.isArray(payload?.toolsUsed) ? payload.toolsUsed : [],
            toolInvocations: Array.isArray(payload?.toolInvocations) ? payload.toolInvocations : [],
            priorToolInvocations: Array.isArray(payload?.priorToolInvocations) ? payload.priorToolInvocations : [],
            turnType: String(payload?.turnType ?? "default").trim() || "default",
            followUpOptions: Array.isArray(payload?.followUpOptions) ? payload.followUpOptions : [],
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
            debug: error?.debug ?? null,
            error: messageText,
            toolInvocations: [],
            priorToolInvocations: [],
            turnType: "default",
            followUpOptions: [],
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
    const implicitFollowUpSelection = buildImplicitBroaderFollowUpSelection(
      activeBroaderAnswerClarificationTurn,
      message,
    );

    if (!message || isSubmitting || isPromptInOptionMode || !isVisibilityReady) {
      return;
    }

    setPrompt("");
    await submitTurn({
      question: message,
      message,
      followUpSelection: implicitFollowUpSelection,
    });
  }

  function handlePromptKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent?.isComposing) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function handleFollowUpOptionClick(option) {
    if (!activeNoResultOfferTurn || isSubmitting) {
      return;
    }

    const optionId = String(option?.optionId ?? "").trim();
    const label = String(option?.label ?? "").trim();
    const sourceQuestion = String(activeNoResultOfferTurn.question ?? "").trim();
    const submissionMessage = buildFollowUpSubmissionMessage(optionId, label);

    if (!optionId || !label) {
      return;
    }

    await submitTurn({
      question: submissionMessage,
      message: submissionMessage,
      followUpSelection: {
        sourceTurnId: activeNoResultOfferTurn.id,
        optionId,
        sourceQuestion,
        sourceToolInvocations: Array.isArray(activeNoResultOfferTurn.toolInvocations)
          ? activeNoResultOfferTurn.toolInvocations.map((invocation) => ({
            toolName: invocation?.toolName,
            resultCount: invocation?.resultCount,
          }))
          : [],
      },
    });
  }

  async function handleAddToToolClick(event, turn, toolName) {
    event.preventDefault();
    event.stopPropagation();

    if (isSubmitting || addActionState?.status === "pending") {
      return;
    }

    const normalizedToolName = String(toolName ?? "").trim();
    const targetTreeId = parseToolTreeId(normalizedToolName);
    const originalQuestion = String(turn?.originalQuestion ?? turn?.question ?? "").trim();
    const broaderAnswer = String(turn?.answer ?? "").trim();

    if (!targetTreeId || !writableTreeIdSet.has(targetTreeId)) {
      setAddActionState({
        status: "error",
        turnId: turn?.id ?? null,
        toolName: normalizedToolName,
        message: "Read-only: only the owner or assigned editors can add notes to this tree.",
      });
      return;
    }

    if (!normalizedToolName || !originalQuestion || !broaderAnswer) {
      setAddActionState({
        status: "error",
        turnId: turn?.id ?? null,
        toolName: normalizedToolName,
        message: "This answer does not have enough context to create a new leaf note.",
      });
      return;
    }

    setAddActionState({
      status: "pending",
      turnId: turn.id,
      toolName: normalizedToolName,
      message: "Finding the best place in the tree...",
    });

    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "preview-leaf-from-chat",
          toolName: normalizedToolName,
          originalQuestion,
          broaderAnswer,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error || "Unable to add this answer to the tree.");
      }

      setAddActionState({
        status: "confirm",
        turnId: turn.id,
        toolName: normalizedToolName,
        message: payload.generatedPathTitles?.length
          ? `Create "${payload.generatedLeafTitle}" under ${payload.plannedLeafParentBreadcrumb}?`
          : `Create a new leaf note under ${payload.plannedLeafParentBreadcrumb}?`,
        preview: payload,
      });
    } catch (error) {
      setAddActionState({
        status: "error",
        turnId: turn.id,
        toolName: normalizedToolName,
        message: error instanceof Error ? error.message : "Unable to add this answer to the tree.",
      });
    }
  }

  async function handleConfirmAddToTool(event, turn) {
    event.preventDefault();
    event.stopPropagation();

    if (addActionState?.status !== "confirm" || addActionState.turnId !== turn.id) {
      return;
    }

    const preview = addActionState.preview;

    if (!writableTreeIdSet.has(String(preview?.treeId ?? ""))) {
      setAddActionState({
        status: "error",
        turnId: turn.id,
        toolName: addActionState.toolName,
        message: "Read-only: only the owner or assigned editors can add notes to this tree.",
      });
      return;
    }

    setAddActionState({
      ...addActionState,
      status: "pending",
      message: preview.generatedPathTitles?.length ? "Creating new path and leaf note..." : "Creating new leaf note...",
    });

    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "create-leaf-from-chat",
          treeId: preview.treeId,
          toolName: addActionState.toolName,
          originalQuestion: preview.originalQuestion,
          broaderAnswer: preview.broaderAnswer,
          placementMode: preview.placementMode,
          selectedAnchorNodeId: preview.selectedAnchorNodeId,
          selectedAnchorBreadcrumb: preview.selectedAnchorBreadcrumb,
          generatedPathTitles: preview.generatedPathTitles,
          plannedLeafParentBreadcrumb: preview.plannedLeafParentBreadcrumb,
          generatedLeafTitle: preview.generatedLeafTitle,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error || "Unable to add this answer to the tree.");
      }

      const indexerMessage = payload.indexerRun?.status === "requested"
        ? " Search index refresh requested."
        : payload.indexerRun?.status === "already-running"
          ? " Search index refresh is already running."
          : payload.indexerRun?.status === "skipped"
            ? ` Note created, but search index refresh was skipped: ${payload.indexerRun.reason}`
            : payload.indexerRun?.status === "failed"
              ? ` Note created, but search index refresh failed: ${payload.indexerRun.message}`
              : "";

      setAddActionState({
        status: "success",
        turnId: turn.id,
        toolName: addActionState.toolName,
        message: payload.createdIntermediateNodes?.length
          ? `Created \"${payload.generatedLeafTitle}\" under ${payload.plannedLeafParentBreadcrumb} with ${payload.createdIntermediateNodes.length} new path node${payload.createdIntermediateNodes.length === 1 ? "" : "s"}.${indexerMessage}`
          : `Created \"${payload.generatedLeafTitle}\" under ${payload.plannedLeafParentBreadcrumb}.${indexerMessage}`,
      });

      const notesSearchParams = new URLSearchParams();
      notesSearchParams.set("treeId", String(payload.treeId));
      notesSearchParams.set("nodeId", String(payload.createdNodeId));
      const notesHref = buildVisibilityHref("/notes", notesSearchParams.toString(), visibility, PUBLIC_PRIVATE_VISIBILITY_VALUES);
      window.open(notesHref, "_blank", "noopener,noreferrer");
    } catch (error) {
      setAddActionState({
        status: "error",
        turnId: turn.id,
        toolName: addActionState.toolName,
        message: error instanceof Error ? error.message : "Unable to add this answer to the tree.",
      });
    }
  }

  async function handlePublishAgentFamily(family) {
    const normalizedFamily = String(family?.family ?? "").trim();
    const familyLabel = String(family?.label ?? normalizedFamily).trim();

    if (!normalizedFamily || !family?.supportsPromptAgentPublishing) {
      return;
    }

    const confirmed = window.confirm(`${buildFamilyPublishLabel(family)} prompt agent for "${familyLabel}"?`);

    if (!confirmed) {
      return;
    }

    const pendingKey = `publish:${normalizedFamily}`;
    setAgentFamilyPending(pendingKey, true);
    setAgentFamiliesStatusMessage("");
    setAgentFamiliesError("");

    try {
      const response = await fetch("/api/admin/agents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          family: normalizedFamily,
          action: "publish",
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error || `Prompt agent for ${familyLabel} could not be published`);
      }

      setAgentFamiliesStatusMessage(formatFamilyPublishMessage(family, payload?.publish));
      await loadAgentFamilies();
    } catch (error) {
      setAgentFamiliesError(getErrorMessage(error, `Prompt agent for ${familyLabel} could not be published`));
    } finally {
      setAgentFamilyPending(pendingKey, false);
    }
  }

  return (
    <main className="appPageShell">
      <section className={`${styles.workspaceGrid} ${!includeDebug ? styles.workspaceGridSingle : ""}`}>
        <div className={styles.chatColumnStack}>
          <div className={styles.chatColumnSurface}>
            <section className={styles.heroCard}>
            <div className={`appPanelTopBar ${styles.promptPanelHeader}`}>
              <p className="appEyebrow">Prompt</p>
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
              <label className={styles.toolbarLabel}>
                <select
                  value={chatFamily}
                  onChange={handleChatFamilyChange}
                  disabled={isSubmitting}
                >
                  <option value="treeGrounding">treeGrounding</option>
                  <option value="investment">investment</option>
                </select>
              </label>
              {isPromptInOptionMode ? null : (
                <button
                  type="submit"
                  form="chat-prompt-form"
                  className={`appCompactActionButton appCompactActionButtonNeutral ${styles.promptToolbarButton}`}
                  disabled={isSubmitting || !prompt.trim() || !isVisibilityReady}
                >
                  {isSubmitting ? "Thinking..." : "Send"}
                </button>
              )}
            </div>
            <form id="chat-prompt-form" onSubmit={handleSubmit} className={styles.composerForm}>
              <label className={styles.composerField}>
                {isPromptInOptionMode ? (
                  <div className={styles.followUpComposerCard}>
                    <div className={styles.followUpActionRow}>
                      {activeNoResultOfferTurn.followUpOptions.map((option) => (
                        <button
                          key={`${activeNoResultOfferTurn.id}-${option.optionId}`}
                          type="button"
                          className={styles.followUpPrimaryButton}
                          onClick={() => handleFollowUpOptionClick(option)}
                          disabled={isSubmitting}
                        >
                          {option.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        className={styles.followUpSecondaryButton}
                        onClick={() => setDismissedFollowUpTurnId(activeNoResultOfferTurn.id)}
                        disabled={isSubmitting}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={handlePromptKeyDown}
                    placeholder={buildChatPlaceholder()}
                    className={styles.textArea}
                    rows={4}
                  />
                )}
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
                    {includeDebug
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
                          {toolBadgeState.addTargets.map((target) => {
                            const targetTreeId = parseToolTreeId(target.toolName);
                            const canAddToTool = Boolean(targetTreeId) && writableTreeIdSet.has(targetTreeId);

                            return (
                              <button
                                key={`${turn.id}-${target.toolName}`}
                                type="button"
                                className={`appCompactActionButton appCompactActionButtonNeutral ${styles.addToToolChipButton}`}
                                onClick={(event) => handleAddToToolClick(event, turn, target.toolName)}
                                disabled={addActionState?.status === "pending" || !canAddToTool}
                                title={canAddToTool ? target.label : "Read-only: only the owner or assigned editors can add notes to this tree."}
                              >
                                {target.label}
                              </button>
                            );
                          })}
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
                          ) : renderAgentAnswerContent(
                            turn.answer || "No answer returned.",
                            `${turn.id}-answer`,
                            `${styles.messageText} ${isCompactTurnState ? styles.messageTextPending : ""}`,
                          )}
                        </div>
                        {addActionState?.turnId === turn.id ? (
                          <div className={styles.addActionPanel}>
                            <p className={addActionState.status === "error" ? styles.addActionError : styles.addActionStatus}>
                              {addActionState.message}
                            </p>
                            {addActionState.status === "confirm" ? (
                              <div className={styles.addActionControls}>
                                <button
                                  type="button"
                                  className={styles.addActionConfirmButton}
                                  onClick={(event) => handleConfirmAddToTool(event, turn)}
                                >
                                  Confirm
                                </button>
                                <button
                                  type="button"
                                  className={styles.addActionCancelButton}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setAddActionState(null);
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      <div className={`${styles.messageBubbleUser} ${isCompactTurnState ? styles.messageBubblePending : ""}`}>
                        <p className={styles.messageLabel}>User</p>
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

          {isAdmin ? (
            <section className={`appPanelShell ${styles.agentManagementPanel}`}>
              <div className={`appPanelTopBar ${styles.panelHeader}`}>
                <div>
                  <p className="appEyebrow">Agent Family Publishing</p>
                </div>
              </div>
              <div className={styles.agentManagementBody}>
                <p className={styles.agentManagementIntro}>
                  View registered agent families and publish or re-publish Azure prompt agents for supported families.
                </p>

                {agentFamiliesStatusMessage ? <p className={styles.agentManagementStatus}>{agentFamiliesStatusMessage}</p> : null}
                {agentFamiliesError ? <p className={styles.agentManagementError}>{agentFamiliesError}</p> : null}

                {isAgentFamiliesLoading ? (
                  <div className={`${styles.emptyState} ${styles.emptyStateCompact}`}>
                    <h3>Loading agent families</h3>
                    <p>Checking prompt agent publishing status for the registered families.</p>
                  </div>
                ) : agentFamilies.length === 0 ? (
                  <div className={`${styles.emptyState} ${styles.emptyStateCompact}`}>
                    <h3>No families available</h3>
                    <p>No agent families were returned for management.</p>
                  </div>
                ) : (
                  <div className={styles.agentFamilyList}>
                    {agentFamilies.map((family) => {
                      const pendingKey = `publish:${family.family}`;
                      const isPending = Boolean(agentFamilyPendingItems[pendingKey]);
                      const definedTools = getFamilyDefinedTools(family);

                      return (
                        <article key={family.family} className={styles.agentFamilyCard}>
                          <div className={styles.agentFamilyHeader}>
                            <div className={styles.agentFamilyHeading}>
                              <h3 className={styles.agentFamilyTitle}>{family.label || family.family}</h3>
                              {family.description ? <p className={styles.agentFamilyDescription}>{family.description}</p> : null}
                            </div>
                            <span className={`${styles.agentFamilyStatusBadge} ${getFamilyStatusClassName(styles, family.promptAgentStatus)}`}>
                              {formatFamilyPromptAgentStatus(family.promptAgentStatus)}
                            </span>
                          </div>

                          <div className={styles.agentFamilyMetaList}>
                            <p className={styles.agentFamilyMetaItem}>
                              <span className={styles.agentFamilyMetaLabel}>Family</span>
                              <span className={styles.agentFamilyMetaValue}>{family.family}</span>
                            </p>
                            <p className={styles.agentFamilyMetaItem}>
                              <span className={styles.agentFamilyMetaLabel}>Prompt agent</span>
                              <span className={styles.agentFamilyMetaValue}>{family.promptAgentName || "Not set"}</span>
                            </p>
                            <p className={styles.agentFamilyMetaItem}>
                              <span className={styles.agentFamilyMetaLabel}>Last published</span>
                              <span className={styles.agentFamilyMetaValue}>{formatFamilyLastPublished(family)}</span>
                            </p>
                            <p className={styles.agentFamilyMetaItem}>
                              <span className={styles.agentFamilyMetaLabel}>Prompt agent publishing</span>
                              <span className={styles.agentFamilyMetaValue}>{family.supportsPromptAgentPublishing ? "Supported" : "Not supported yet"}</span>
                            </p>
                          </div>

                          <div className={styles.agentFamilyMetaItemStack}>
                            <div className={styles.agentFamilyMetaItem}>
                              <span className={styles.agentFamilyMetaLabel}>Defined tools</span>
                              <span className={styles.agentFamilyMetaValue}>{definedTools.length}</span>
                            </div>

                            {definedTools.length > 0 ? (
                              <div className={styles.agentFamilyToolsList}>
                                {definedTools.map((tool) => (
                                  <article
                                    key={`${family.family}-${tool.name || tool.description}`}
                                    className={styles.agentFamilyToolCard}
                                  >
                                    <div className={styles.agentFamilyToolHeader}>
                                      <p className={styles.agentFamilyToolName}>{tool.name || "Unnamed tool"}</p>
                                      {tool.sourceLabel ? (
                                        <span className={styles.agentFamilyToolSource}>{tool.sourceLabel}</span>
                                      ) : null}
                                    </div>
                                    {tool.description ? (
                                      <p className={styles.agentFamilyToolDescription}>{tool.description}</p>
                                    ) : null}
                                  </article>
                                ))}
                              </div>
                            ) : (
                              <p className={styles.agentFamilyToolsEmpty}>No tool definitions are available for this family.</p>
                            )}
                          </div>

                          {family.statusError ? <p className={styles.agentFamilyRowError}>{family.statusError}</p> : null}

                          <div className={styles.agentFamilyActions}>
                            {family.supportsPromptAgentPublishing ? (
                              <button
                                type="button"
                                className="appCompactActionButton appCompactActionButtonNeutral"
                                onClick={() => handlePublishAgentFamily(family)}
                                disabled={isPending || isAgentFamiliesLoading}
                              >
                                {isPending ? "Publishing..." : buildFamilyPublishLabel(family)}
                              </button>
                            ) : (
                              <span className={styles.agentFamilyUnsupportedNote}>Prompt agent publishing is not supported for this family yet.</span>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          ) : null}
        </div>

        {includeDebug ? (
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