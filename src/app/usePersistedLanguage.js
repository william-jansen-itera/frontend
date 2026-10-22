"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";

const LANGUAGE_STORAGE_KEY = "knowledge-app.language";
const LANGUAGE_CHANGE_EVENT = "knowledge-app-language-change";
let inMemoryLanguage = null;
export const LanguagePreferenceContext = createContext(null);

export function normalizeLanguage(value) {
  const baseLanguage = String(value ?? "").trim().toLowerCase().split("-")[0];
  return baseLanguage === "da" || baseLanguage === "en" ? baseLanguage : null;
}

function getStoredLanguage() {
  try {
    return normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function getLanguageSnapshot() {
  if (typeof window === "undefined") {
    return "en";
  }

  const storedLanguage = getStoredLanguage();
  if (storedLanguage) {
    return storedLanguage;
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

function updateLocalLanguage(language) {
  inMemoryLanguage = language;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // The in-memory value remains available for this tab.
  }
  window.dispatchEvent(new Event(LANGUAGE_CHANGE_EVENT));
}

export function usePersistedLanguage(user, isAuthResolved) {
  const language = useSyncExternalStore(subscribeToLanguage, getLanguageSnapshot, () => "en");
  const [loadedUserId, setLoadedUserId] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const userId = user?.objectId ?? user?.userId ?? null;
  const isReady = isAuthResolved && (!userId || loadedUserId === userId);

  useEffect(() => {
    if (!isAuthResolved) {
      return undefined;
    }

    if (!userId) {
      return undefined;
    }

    const controller = new AbortController();

    async function loadLanguage() {
      try {
        const response = await fetch("/api/me/language", { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          throw new Error("Could not load language preference");
        }

        const data = await response.json();
        const savedLanguage = normalizeLanguage(data.language);
        if (controller.signal.aborted) {
          return;
        }
        if (savedLanguage) {
          updateLocalLanguage(savedLanguage);
        } else {
          const storedLanguage = getStoredLanguage();
          if (storedLanguage) {
            const saveResponse = await fetch("/api/me/language", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ language: storedLanguage }),
              signal: controller.signal,
            });
            if (!saveResponse.ok) {
              throw new Error("Could not initialize language preference");
            }
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          setError("LoadError");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoadedUserId(userId);
        }
      }
    }

    loadLanguage();
    return () => controller.abort();
  }, [userId, isAuthResolved]);

  const setLanguage = async (value) => {
    const nextLanguage = normalizeLanguage(value);
    if (!nextLanguage || !isReady || isSaving || nextLanguage === language) {
      return;
    }

    if (!userId) {
      updateLocalLanguage(nextLanguage);
      return;
    }

    setIsSaving(true);
    setError(null);
    updateLocalLanguage(nextLanguage);

    try {
      const response = await fetch("/api/me/language", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: nextLanguage }),
      });
      if (!response.ok) {
        throw new Error("Could not save language preference");
      }
    } catch {
      updateLocalLanguage(language);
      setError("SaveError");
    } finally {
      setIsSaving(false);
    }
  };

  return { language, setLanguage, isReady, isSaving, error };
}

export function useLanguagePreference() {
  const preference = useContext(LanguagePreferenceContext);
  if (!preference) {
    throw new Error("useLanguagePreference must be used within LanguagePreferenceContext");
  }
  return preference;
}