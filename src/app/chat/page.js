import ChatPageClient from "./ChatPageClient";

function parseBooleanSetting(value, fallbackValue = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalizedValue = value.trim().toLowerCase();

    if (["true", "1", "yes", "on"].includes(normalizedValue)) {
      return true;
    }

    if (["false", "0", "no", "off"].includes(normalizedValue)) {
      return false;
    }
  }

  return fallbackValue;
}

export default function ChatPage() {
  const includeDebug = parseBooleanSetting(process.env.APPLICATION_DEBUG, false);

  return <ChatPageClient includeDebug={includeDebug} />;
}