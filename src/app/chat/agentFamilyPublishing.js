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

export async function fetchAgentFamilyManagementState() {
  const response = await fetch("/api/admin/agents", { cache: "no-store" });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error || "Agent families could not be loaded");
  }

  return Array.isArray(payload?.families) ? payload.families : [];
}

export async function fetchAvailableChatFamilies() {
  const response = await fetch("/api/chat/families", { cache: "no-store" });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error || "Chat families could not be loaded");
  }

  return {
    defaultFamily: String(payload?.defaultFamily ?? "").trim() || null,
    families: Array.isArray(payload?.families) ? payload.families : [],
  };
}

export function getFamilyStatusClassName(stylesheet, family) {
  switch (String(family?.availabilityStatus ?? family?.promptAgentStatus ?? "").trim()) {
    case "active":
      return stylesheet.agentFamilyStatusPublished;
    case "deactivated":
    case "unpublished":
    case "not_published":
      return stylesheet.agentFamilyStatusUnknown;
    case "not_published":
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

export function formatFamilyPromptAgentStatus(family) {
  switch (String(family?.availabilityStatus ?? family?.promptAgentStatus ?? "").trim()) {
    case "active":
      return "Active";
    case "deactivated":
      return "Deactivated";
    case "unpublished":
      return "Unpublished";
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

export function buildFamilyPublishLabel(family) {
  return String(family?.promptAgentStatus ?? "").trim() === "published" ? "Re-publish" : "Publish";
}

export function buildFamilyActivationLabel(family) {
  return family?.isActive ? "Deactivate" : "Activate";
}

export function shouldDisableFamilyActivation(family) {
  return !family?.isActive
    && family?.requiresPublishedPromptAgent
    && String(family?.promptAgentStatus ?? "").trim() !== "published";
}

export function shouldShowFamilyUnpublish(family) {
  return String(family?.promptAgentStatus ?? "").trim() === "published";
}

export function formatFamilyActionMessage(family, action, operation) {
  const familyLabel = String(family?.label ?? family?.family ?? "This family").trim();
  const promptAgentName = String(operation?.promptAgentName ?? family?.promptAgentName ?? "").trim();

  if (action === "activate") {
    return `${familyLabel} is active again.`;
  }

  if (action === "deactivate") {
    return `${familyLabel} is now deactivated.`;
  }

  if (action === "unpublish") {
    return promptAgentName
      ? `${familyLabel} was deactivated and unpublished from ${promptAgentName}.`
      : `${familyLabel} was deactivated and unpublished.`;
  }

  return formatFamilyPublishMessage(family, operation);
}

export function buildFamilyActionConfirmationMessage(family, action) {
  const familyLabel = String(family?.label ?? family?.family ?? "this family").trim();

  if (action === "activate") {
    return `Activate \"${familyLabel}\"?`;
  }

  if (action === "deactivate") {
    return `Deactivate \"${familyLabel}\"?`;
  }

  if (action === "unpublish") {
    return `Unpublish \"${familyLabel}\"? This will deactivate it first.`;
  }

  return `${buildFamilyPublishLabel(family)} prompt agent for \"${familyLabel}\"?`;
}

export function formatFamilyPublishMessage(family, publishStatus) {
  const familyLabel = String(family?.label ?? family?.family ?? "This family").trim();
  const promptAgentName = String(publishStatus?.promptAgentName ?? family?.promptAgentName ?? "").trim();
  const publishedAt = publishStatus?.lastPublishedAt ?? family?.lastPublishedAt ?? null;
  const publishedSuffix = publishedAt ? ` at ${formatDateTimeTimestamp(publishedAt)}` : "";

  return promptAgentName
    ? `${familyLabel} prompt agent published as ${promptAgentName}${publishedSuffix}.`
    : `${familyLabel} prompt agent published${publishedSuffix}.`;
}

export function formatFamilyLastPublished(family) {
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

export function getFamilyDefinedTools(family) {
  if (!Array.isArray(family?.tools)) {
    return [];
  }

  return family.tools.filter((tool) => tool && (tool.name || tool.description));
}

export function normalizeChatFamilySelection(value, availableFamilies, defaultFamily = null) {
  const normalizedValue = String(value ?? "").trim();
  const availableFamilyNames = Array.isArray(availableFamilies)
    ? availableFamilies.map((family) => String(family?.family ?? "").trim()).filter(Boolean)
    : [];
  const fallbackFamily = String(defaultFamily ?? availableFamilyNames[0] ?? "").trim() || null;

  if (normalizedValue && availableFamilyNames.includes(normalizedValue)) {
    return normalizedValue;
  }

  return fallbackFamily;
}

export function setChatFamilySearchParam(searchParams, family, availableFamilies, defaultFamily = null) {
  const normalizedFamily = normalizeChatFamilySelection(family, availableFamilies, defaultFamily);
  const normalizedDefaultFamily = normalizeChatFamilySelection(defaultFamily, availableFamilies, defaultFamily);

  if (!normalizedFamily || normalizedFamily === normalizedDefaultFamily) {
    searchParams.delete("family");
    return;
  }

  searchParams.set("family", normalizedFamily);
}

export function buildChatPlaceholder(availableFamilies) {
  const familyLabels = Array.isArray(availableFamilies)
    ? availableFamilies
      .map((family) => String(family?.label ?? family?.family ?? "").trim().toLowerCase())
      .filter(Boolean)
    : [];

  if (familyLabels.length === 0) {
    return "No chat families are currently available";
  }

  if (familyLabels.length === 1) {
    return `Ask the agent about ${familyLabels[0]}`;
  }

  const leadingLabels = familyLabels.slice(0, -1).join(", ");
  const trailingLabel = familyLabels[familyLabels.length - 1];

  return `Ask the agent about ${leadingLabels}, or ${trailingLabel}`;
}