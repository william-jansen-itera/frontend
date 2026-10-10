import {
  buildAuditLabel as buildSharedAuditLabel,
  formatTimestamp,
  getErrorMessage,
} from "../shared/displayFormatting";
import { ALL_VISIBILITY_VALUES, buildVisibilityHref } from "../usePersistedVisibility";

export { formatTimestamp, getErrorMessage };

export const ADMIN_SECTIONS = [
  {
    href: "/admin/deletions",
    label: "Deleted items",
    description: "Review soft-deleted trees, nodes, and attachments, then undelete or purge them.",
  },
  {
    href: "/admin/agent-publishing",
    label: "Agent publishing",
    description: "Publish, unpublish, activate, and deactivate registered agent families for prompt agent workflows.",
  },
  {
    href: "/admin/analytics",
    label: "Analytics",
    description: "Inspect recent page visit aggregates by page, device class, and browser family.",
  },
  {
    href: "/admin/indexing",
    label: "Indexing",
    description: "Run Azure AI Search indexers incrementally or as full reset-and-run operations.",
  },
  {
    href: "/admin/contact-requests",
    label: "Contact requests",
    description: "Review the last 30 days of contact intake without surfacing that list on the public page.",
  },
];

export const INDEXING_COLUMNS = [
  { key: "incremental", label: "incremental" },
  { key: "full", label: "full" },
];

export const INDEXING_ROWS = [
  { key: "node-data", label: "node data" },
  { key: "blob-content", label: "attachment content" },
  { key: "all", label: "all" },
];

export function buildAdminHref(pathname, searchParamsString, visibility) {
  return buildVisibilityHref(pathname, searchParamsString, visibility, ALL_VISIBILITY_VALUES);
}

export function formatVisitCount(value) {
  const normalizedValue = Number(value ?? 0);

  if (!Number.isFinite(normalizedValue)) {
    return "0";
  }

  return normalizedValue.toLocaleString();
}

export function buildAuditLabel(userDetails, timestamp, defaultLabel = null) {
  return buildSharedAuditLabel(userDetails, timestamp, defaultLabel, "Updated ");
}

export function formatIndexingResultMessage(result) {
  const targetLabel = INDEXING_ROWS.find((row) => row.key === result?.target)?.label || "indexing";
  const modeLabel = result?.mode === "full" ? "Full" : "Incremental";
  const operations = Array.isArray(result?.operations) ? result.operations : [];

  if (operations.length === 0) {
    return `${modeLabel} ${targetLabel} indexing request was accepted.`;
  }

  const summary = operations
    .map((operation) => `${operation.operation} ${operation.indexerName} (${operation.status})`)
    .join(", ");

  return `${modeLabel} ${targetLabel} indexing started: ${summary}.`;
}

export function formatIndexingErrorMessage(result, fallbackMessage) {
  const baseMessage = String(result?.error || fallbackMessage || "Indexing request failed").trim();
  const operations = Array.isArray(result?.operations) ? result.operations : [];
  const failedOperations = Array.isArray(result?.failedOperations) ? result.failedOperations : [];
  const detailParts = [];

  if (operations.length > 0) {
    detailParts.push(`completed ${operations.map((operation) => `${operation.operation} ${operation.indexerName} (${operation.status})`).join(", ")}`);
  }

  if (failedOperations.length > 0) {
    detailParts.push(`failed ${failedOperations.map((operation) => `${operation.operation} ${operation.indexerName}${operation.error ? `: ${operation.error}` : ""}`).join(", ")}`);
  }

  return detailParts.length > 0 ? `${baseMessage} (${detailParts.join("; ")})` : baseMessage;
}