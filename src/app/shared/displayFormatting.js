export function getErrorMessage(error, fallbackMessage) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallbackMessage;
}

export function formatTimestamp(value) {
  if (!value) {
    return "Unknown time";
  }

  const parsedValue = new Date(value);

  if (Number.isNaN(parsedValue.getTime())) {
    return "Unknown time";
  }

  return parsedValue.toLocaleString();
}

export function buildAuditLabel(userDetails, timestamp, defaultLabel = null, timestampPrefix = "") {
  const parts = [];
  const normalizedUserDetails = String(userDetails ?? "").trim();
  const formattedTimestamp = timestamp ? formatTimestamp(timestamp) : null;

  if (normalizedUserDetails) {
    parts.push(normalizedUserDetails);
  }

  if (formattedTimestamp && formattedTimestamp !== "Unknown time") {
    parts.push(`${timestampPrefix}${formattedTimestamp}`.trim());
  }

  if (parts.length === 0) {
    return defaultLabel;
  }

  return parts.join(" • ");
}