"use client";

import { useSyncExternalStore } from "react";

const LANGUAGE_STORAGE_KEY = "knowledge-app.language";
const LANGUAGE_CHANGE_EVENT = "knowledge-app-language-change";
let inMemoryLanguage = null;

export function normalizeLanguage(value) {
  const baseLanguage = String(value ?? "").trim().toLowerCase().split("-")[0];
  return baseLanguage === "da" || baseLanguage === "en" ? baseLanguage : null;
}

function getLanguageSnapshot() {
  if (typeof window === "undefined") {
    return "en";
  }

  try {
    const storedLanguage = normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
    if (storedLanguage) {
      return storedLanguage;
    }
  } catch {
    // Keep the selection usable when storage is unavailable.
  }

  if (inMemoryLanguage) {
    return inMemoryLanguage;
  }

  const browserLanguages = window.navigator.languages?.length
    ? window.navigator.languages
    : [window.navigator.language];
  return browserLanguages.map(normalizeLanguage).find(Boolean) ?? "en";
}

function subscribeToLanguage(onStoreChange) {
  const handleStorage = (event) => {
    if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) {
      inMemoryLanguage = null;
      onStoreChange();
    }
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(LANGUAGE_CHANGE_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(LANGUAGE_CHANGE_EVENT, onStoreChange);
  };
}

export function usePersistedLanguage() {
  const language = useSyncExternalStore(subscribeToLanguage, getLanguageSnapshot, () => "en");

  const setLanguage = (value) => {
    const nextLanguage = normalizeLanguage(value);
    if (!nextLanguage) {
      return;
    }

    inMemoryLanguage = nextLanguage;
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
    } catch {
      // The in-memory value remains available for this tab.
    }
    window.dispatchEvent(new Event(LANGUAGE_CHANGE_EVENT));
  };

  return { language, setLanguage };
}