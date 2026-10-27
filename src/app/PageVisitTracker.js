"use client";

import { useEffect } from 'react';

export default function PageVisitTracker({ pagePath }) {
  useEffect(() => {
    const abortController = new AbortController();
    const pageUrl = window.location.href;
    const documentReferrer = document.referrer;
    const isWebDriver = navigator.webdriver === true;

    fetch('/api/analytics/visits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pagePath, pageUrl, documentReferrer, isWebDriver }),
      cache: 'no-store',
      keepalive: true,
      signal: abortController.signal,
    }).catch(() => {
      // Analytics should never block page behavior.
    });

    return () => {
      abortController.abort();
    };
  }, [pagePath]);

  return null;
}