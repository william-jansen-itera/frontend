"use client";

import { useSyncExternalStore } from "react";

const VISIBILITY_STORAGE_KEY = "knowledge-app.visibility";
const VISIBILITY_CHANGE_EVENT = "knowledge-app-visibility-change";

export const ALL_VISIBILITY_VALUES = ["public", "private", "both"];
export const PUBLIC_PRIVATE_VISIBILITY_VALUES = ["public", "private"];

function subscribeToVisibilityChanges(onStoreChange) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleVisibilityChange = (event) => {
    if (!event || event.type === VISIBILITY_CHANGE_EVENT || event.key === VISIBILITY_STORAGE_KEY) {
      onStoreChange();
    }
  };

  window.addEventListener("storage", handleVisibilityChange);
  window.addEventListener(VISIBILITY_CHANGE_EVENT, handleVisibilityChange);

  return () => {
    window.removeEventListener("storage", handleVisibilityChange);
    window.removeEventListener(VISIBILITY_CHANGE_EVENT, handleVisibilityChange);
  };
}

function getStoredVisibilitySnapshot() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(VISIBILITY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function notifyVisibilityChanged() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(VISIBILITY_CHANGE_EVENT));
}

function normalizeAllowedValues(allowedValues) {
  return Array.isArray(allowedValues) && allowedValues.length > 0
    ? allowedValues
    : ALL_VISIBILITY_VALUES;
}

export function normalizeVisibilityValue(value, allowedValues = ALL_VISIBILITY_VALUES, defaultValue = "public") {
  const resolvedAllowedValues = normalizeAllowedValues(allowedValues);
  const normalizedValue = String(value ?? "").trim().toLowerCase();

  if (resolvedAllowedValues.includes(normalizedValue)) {
    return normalizedValue;
  }

  if (normalizedValue === "both" && resolvedAllowedValues.includes("private")) {
    return "private";
  }

  if (resolvedAllowedValues.includes(defaultValue)) {
    return defaultValue;
  }

  return resolvedAllowedValues[0] ?? "public";
}

export function setVisibilitySearchParam(searchParams, visibility, allowedValues = ALL_VISIBILITY_VALUES) {
  const normalizedVisibility = normalizeVisibilityValue(visibility, allowedValues);

  if (normalizedVisibility === "public") {
    searchParams.delete("visibility");
    return normalizedVisibility;
  }

  searchParams.set("visibility", normalizedVisibility);
  return normalizedVisibility;
}

export function buildVisibilityHref(pathname, searchParamsString, visibility, allowedValues = ALL_VISIBILITY_VALUES) {
  const nextSearchParams = new URLSearchParams(searchParamsString);
  setVisibilitySearchParam(nextSearchParams, visibility, allowedValues);
  const nextQueryString = nextSearchParams.toString();
  return nextQueryString ? `${pathname}?${nextQueryString}` : pathname;
}

export function usePersistedVisibility({
  requestedVisibility,
  allowedValues = ALL_VISIBILITY_VALUES,
  defaultValue = "public",
}) {
  const resolvedAllowedValues = normalizeAllowedValues(allowedValues);
  const hasRequestedVisibility = requestedVisibility !== null && requestedVisibility !== undefined && String(requestedVisibility).trim() !== "";
  const normalizedRequestedVisibility = hasRequestedVisibility
    ? normalizeVisibilityValue(requestedVisibility, resolvedAllowedValues, defaultValue)
    : null;
  const storedVisibility = useSyncExternalStore(
    subscribeToVisibilityChanges,
    getStoredVisibilitySnapshot,
    () => null,
  );
  const visibility = normalizedRequestedVisibility ?? normalizeVisibilityValue(
    storedVisibility,
    resolvedAllowedValues,
    defaultValue,
  );

  const setVisibility = (nextVisibility) => {
    const normalizedNextVisibility = normalizeVisibilityValue(nextVisibility, resolvedAllowedValues, defaultValue);

    try {
      window.localStorage.setItem(VISIBILITY_STORAGE_KEY, normalizedNextVisibility);
    } catch {
      // Ignore localStorage failures and keep the in-memory selection.
    }

    notifyVisibilityChanged();

    return normalizedNextVisibility;
  };

  return {
    visibility,
    isReady: true,
    setVisibility,
  };
}