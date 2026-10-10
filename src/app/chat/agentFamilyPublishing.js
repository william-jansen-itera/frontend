export async function parseApiResponseBody(response) {
  const responseText = await response.text();

  if (!responseText) {
    return null;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return {
      error: responseText,
      rawText: responseText,
    };
  }
}

export async function fetchAvailableChatFamilies() {
  const response = await fetch("/api/chat/families", { cache: "no-store" });
  const payload = await parseApiResponseBody(response);

  if (!response.ok) {
    throw new Error(payload?.error || "Chat families could not be loaded");
  }

  return {
    defaultFamily: String(payload?.defaultFamily ?? "").trim() || null,
    families: Array.isArray(payload?.families) ? payload.families : [],
  };
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