"use client";

import { useEffect, useRef, useState } from "react";

export function usePanelLayout() {
  const [availablePageHeight, setAvailablePageHeight] = useState(0);
  const [treeContentHeight, setTreeContentHeight] = useState(0);
  const pageContainerRef = useRef(null);
  const treeContentRef = useRef(null);

  const panelHeight = availablePageHeight || 600;
  const treeHeight = treeContentHeight || 240;

  useEffect(() => {
    const updateAvailablePageHeight = () => {
      const pageContainer = pageContainerRef.current;
      if (!pageContainer) {
        return;
      }

      const { top } = pageContainer.getBoundingClientRect();
      const nextHeight = Math.max(Math.floor(window.innerHeight - top - 16), 0);
      setAvailablePageHeight(nextHeight);
    };

    updateAvailablePageHeight();
    window.addEventListener("resize", updateAvailablePageHeight);

    return () => {
      window.removeEventListener("resize", updateAvailablePageHeight);
    };
  }, []);

  useEffect(() => {
    const treeContentElement = treeContentRef.current;
    if (!treeContentElement) {
      return undefined;
    }

    const updateTreeContentHeight = () => {
      setTreeContentHeight(treeContentElement.clientHeight);
    };

    updateTreeContentHeight();

    const resizeObserver = new ResizeObserver(() => {
      updateTreeContentHeight();
    });

    resizeObserver.observe(treeContentElement);

    return () => {
      resizeObserver.disconnect();
    };
  }, [panelHeight]);

  return {
    pageContainerRef,
    treeContentRef,
    panelHeight,
    treeHeight,
  };
}