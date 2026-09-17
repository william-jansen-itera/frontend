"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "../useAuth";
import styles from "./page.module.css";
import {
  PUBLIC_PRIVATE_VISIBILITY_VALUES,
  buildVisibilityHref,
  setVisibilitySearchParam,
  usePersistedVisibility,
} from "../usePersistedVisibility";

function getErrorMessage(error, fallbackMessage) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallbackMessage;
}

function buildDraftNames(trees) {
  return trees.reduce((drafts, tree) => {
    drafts[String(tree.id)] = tree.name;
    return drafts;
  }, {});
}

function buildDraftVisibility(trees, currentDrafts = {}, resetTreeIds = new Set()) {
  return trees.reduce((drafts, tree) => {
    const treeId = String(tree.id);
    const storedVisibility = tree.isPrivate ? "private" : "public";

    drafts[treeId] = resetTreeIds.has(treeId)
      ? storedVisibility
      : (currentDrafts[treeId] ?? storedVisibility);

    return drafts;
  }, {});
}

function buildDraftDescriptions(trees, currentDrafts = {}, resetTreeIds = new Set()) {
  return trees.reduce((drafts, tree) => {
    const treeId = String(tree.id);
    const storedDescription = String(tree.description ?? "");

    drafts[treeId] = resetTreeIds.has(treeId)
      ? storedDescription
      : (currentDrafts[treeId] ?? storedDescription);

    return drafts;
  }, {});
}

function buildNextDraftNames(trees, currentDrafts = {}, resetTreeIds = new Set()) {
  return trees.reduce((drafts, tree) => {
    const treeId = String(tree.id);
    drafts[treeId] = resetTreeIds.has(treeId) ? tree.name : (currentDrafts[treeId] ?? tree.name);
    return drafts;
  }, {});
}

function filterTreeStateByList(currentState, trees) {
  const allowedTreeIds = new Set(trees.map((tree) => String(tree.id)));

  return Object.fromEntries(
    Object.entries(currentState).filter(([treeId]) => allowedTreeIds.has(treeId)),
  );
}

function normalizeComparableValue(value) {
  return String(value ?? "").trim();
}

function getOwnerLabel(tree) {
  return String(tree?.ownerDisplayName ?? "").trim()
    || String(tree?.ownerUserDetails ?? "").trim()
    || "No owner assigned";
}

function getDefaultTransferQuery(tree) {
  return getOwnerLabel(tree);
}

function getTransferTargetLabel(target) {
  if (!target) {
    return "";
  }

  return String(target.displayName ?? "").trim()
    || String(target.userDetails ?? "").trim()
    || String(target.objectId ?? "").trim();
}

function getCurrentOwnerTransferTarget(tree) {
  const objectId = String(tree?.ownerObjectId ?? "").trim();

  if (!objectId) {
    return null;
  }

  return {
    objectId,
    displayName: String(tree?.ownerDisplayName ?? "").trim() || String(tree?.ownerUserDetails ?? "").trim() || "Current owner",
    userDetails: String(tree?.ownerUserDetails ?? "").trim() || objectId,
    isCurrentOwner: true,
  };
}

function buildTransferOptions(tree, matches) {
  const uniqueOptions = new Map();
  const currentOwnerTarget = getCurrentOwnerTransferTarget(tree);

  for (const match of Array.isArray(matches) ? matches : []) {
    const objectId = String(match?.objectId ?? "").trim();

    if (!objectId) {
      continue;
    }

    uniqueOptions.set(objectId, {
      ...match,
      isCurrentOwner: objectId === currentOwnerTarget?.objectId,
    });
  }

  return Array.from(uniqueOptions.values());
}

function buildEditorOptions(tree, matches) {
  const ownerObjectId = String(tree?.ownerObjectId ?? "").trim();
  const assignedEditorIds = new Set(
    (Array.isArray(tree?.editors) ? tree.editors : [])
      .map((editor) => String(editor?.objectId ?? "").trim())
      .filter(Boolean),
  );
  const uniqueOptions = new Map();

  for (const match of Array.isArray(matches) ? matches : []) {
    const objectId = String(match?.objectId ?? "").trim();

    if (!objectId) {
      continue;
    }

    uniqueOptions.set(objectId, {
      ...match,
      isCurrentOwner: objectId === ownerObjectId,
      isAssignedEditor: assignedEditorIds.has(objectId),
    });
  }

  return Array.from(uniqueOptions.values());
}

function getEditorLabel(editor) {
  return String(editor?.displayName ?? "").trim()
    || String(editor?.userDetails ?? "").trim()
    || String(editor?.objectId ?? "").trim()
    || "Unknown editor";
}

function formatSyncError(syncStatus) {
  if (!syncStatus || syncStatus.status !== "failed") {
    return "";
  }

  const missingTrees = Array.isArray(syncStatus.missingTrees) ? syncStatus.missingTrees : [];

  if (missingTrees.length === 0) {
    return syncStatus.message || "Stored-description sync failed.";
  }

  const missingTreeLabels = missingTrees.map((tree) => tree?.name || `Tree ${tree?.id ?? "?"}`);
  return `${syncStatus.message} Missing descriptions: ${missingTreeLabels.join(", ")}.`;
}

function formatPublishOutcomeMessage(syncStatus, treeId) {
  const excludedTrees = Array.isArray(syncStatus?.excludedTrees) ? syncStatus.excludedTrees : [];

  const isExcluded = excludedTrees.some((tree) => String(tree?.id ?? "") === String(treeId));

  if (isExcluded) {
    return "Description was empty and not published to the agent.";
  }

  return "Stored description was published to the agent.";
}

function formatReviewStatusLabel(reviewStatus) {
  const normalizedStatus = String(reviewStatus ?? "draft").trim().toLowerCase();

  if (normalizedStatus === "submitted") {
    return "Submitted";
  }

  if (normalizedStatus === "approved") {
    return "Approved";
  }

  if (normalizedStatus === "rejected") {
    return "Rejected";
  }

  return "Draft";
}

function promptForRejectionComment(targetLabel) {
  const nextComment = window.prompt(`Enter a rejection comment for ${targetLabel}:`, "");

  if (nextComment === null) {
    return null;
  }

  const normalizedComment = String(nextComment).trim();

  if (!normalizedComment) {
    window.alert("A rejection comment is required.");
    return null;
  }

  return normalizedComment;
}

function getTreeReviewScopeLabel(treeName) {
  return `tree "${treeName}" and everything in it, including all nodes, leaves, and attachments`;
}

function getReviewStatusClassName(reviewStatus, styles) {
  const normalizedStatus = String(reviewStatus ?? "draft").trim().toLowerCase();

  if (normalizedStatus === "submitted") {
    return styles.reviewStatusSubmitted;
  }

  if (normalizedStatus === "approved") {
    return styles.reviewStatusApproved;
  }

  if (normalizedStatus === "rejected") {
    return styles.reviewStatusRejected;
  }

  return styles.reviewStatusDraft;
}

function formatReviewTimestamp(value) {
  if (!value) {
    return null;
  }

  const parsedValue = new Date(value);

  if (Number.isNaN(parsedValue.getTime())) {
    return null;
  }

  return parsedValue.toLocaleString();
}

function formatReviewAuditLabel(tree) {
  const reviewStatus = String(tree?.reviewStatus ?? "draft").trim().toLowerCase();
  const submittedTimestamp = formatReviewTimestamp(tree?.submittedAt);
  const reviewedTimestamp = formatReviewTimestamp(tree?.reviewedAt);

  if (reviewStatus === "submitted") {
    const parts = [];
    const submittedByUserDetails = String(tree?.submittedByUserDetails ?? "").trim();

    if (submittedByUserDetails) {
      parts.push(`Submitted by ${submittedByUserDetails}`);
    }

    if (submittedTimestamp) {
      parts.push(submittedTimestamp);
    }

    return parts.join(" • ") || "Submitted for review";
  }

  if (reviewStatus === "approved") {
    const parts = [];
    const reviewedByUserDetails = String(tree?.reviewedByUserDetails ?? "").trim();

    if (reviewedByUserDetails) {
      parts.push(`Approved by ${reviewedByUserDetails}`);
    }

    if (reviewedTimestamp) {
      parts.push(reviewedTimestamp);
    }

    return parts.join(" • ") || "Approved";
  }

  if (reviewStatus === "rejected") {
    const parts = [];
    const reviewedByUserDetails = String(tree?.reviewedByUserDetails ?? "").trim();

    if (reviewedByUserDetails) {
      parts.push(`Rejected by ${reviewedByUserDetails}`);
    }

    if (reviewedTimestamp) {
      parts.push(reviewedTimestamp);
    }

    return parts.join(" • ") || "Rejected";
  }

  return "Not yet submitted";
}

function TreesPageContent() {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedVisibilityParam = searchParams.get("visibility");
  const {
    visibility: visibilityFilter,
    isReady: isVisibilityReady,
    setVisibility: setPersistedVisibility,
  } = usePersistedVisibility({
    requestedVisibility: requestedVisibilityParam,
    allowedValues: PUBLIC_PRIVATE_VISIBILITY_VALUES,
  });
  const [trees, setTrees] = useState([]);
  const [draftNames, setDraftNames] = useState({});
  const [draftVisibility, setDraftVisibility] = useState({});
  const [draftDescriptions, setDraftDescriptions] = useState({});
  const [editingDescriptions, setEditingDescriptions] = useState({});
  const [newTreeName, setNewTreeName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [rowPendingStates, setRowPendingStates] = useState({});
  const [rowFeedback, setRowFeedback] = useState({});
  const [transferQueries, setTransferQueries] = useState({});
  const [transferMatches, setTransferMatches] = useState({});
  const [selectedTransferTargets, setSelectedTransferTargets] = useState({});
  const [editorQueries, setEditorQueries] = useState({});
  const [editorMatches, setEditorMatches] = useState({});
  const [selectedEditorTargets, setSelectedEditorTargets] = useState({});
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  const handleVisibilityFilterChange = (event) => {
    const nextVisibility = setPersistedVisibility(event.target.value);
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    setVisibilitySearchParam(nextSearchParams, nextVisibility, PUBLIC_PRIVATE_VISIBILITY_VALUES);
    const nextQueryString = nextSearchParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  };

  useEffect(() => {
    if (!isVisibilityReady) {
      return;
    }

    if (!requestedVisibilityParam && visibilityFilter === "public") {
      return;
    }

    if (requestedVisibilityParam === visibilityFilter) {
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    setVisibilitySearchParam(nextSearchParams, visibilityFilter, PUBLIC_PRIVATE_VISIBILITY_VALUES);
    const nextQueryString = nextSearchParams.toString();
    router.replace(nextQueryString ? `${pathname}?${nextQueryString}` : pathname, { scroll: false });
  }, [isVisibilityReady, pathname, requestedVisibilityParam, router, searchParams, visibilityFilter]);

  const applyTreeList = (nextTrees, options = {}) => {
    const resetNameTreeIds = new Set((options.resetNameTreeIds ?? []).map((treeId) => String(treeId)));
    const resetVisibilityTreeIds = new Set((options.resetVisibilityTreeIds ?? []).map((treeId) => String(treeId)));
    const resetDescriptionTreeIds = new Set((options.resetDescriptionTreeIds ?? []).map((treeId) => String(treeId)));

    setTrees(nextTrees);
    setDraftNames((currentDrafts) => buildNextDraftNames(nextTrees, currentDrafts, resetNameTreeIds));
    setDraftVisibility((currentDrafts) => buildDraftVisibility(nextTrees, currentDrafts, resetVisibilityTreeIds));
    setDraftDescriptions((currentDrafts) => buildDraftDescriptions(nextTrees, currentDrafts, resetDescriptionTreeIds));
    setEditingDescriptions((currentState) => filterTreeStateByList(currentState, nextTrees));
    setRowPendingStates((currentState) => filterTreeStateByList(currentState, nextTrees));
    setRowFeedback((currentState) => filterTreeStateByList(currentState, nextTrees));
    setTransferQueries((currentState) => Object.fromEntries(
      nextTrees.map((tree) => {
        const treeId = String(tree.id);
        const currentQuery = String(currentState[treeId] ?? "");

        return [treeId, currentQuery.trim() ? currentQuery : getDefaultTransferQuery(tree)];
      }),
    ));
    setTransferMatches((currentState) => filterTreeStateByList(currentState, nextTrees));
    setSelectedTransferTargets((currentState) => Object.fromEntries(
      nextTrees.map((tree) => {
        const treeId = String(tree.id);
        const filteredSelection = currentState[treeId] ?? null;

        return [treeId, filteredSelection ?? getCurrentOwnerTransferTarget(tree)];
      }),
    ));
    setEditorQueries((currentState) => filterTreeStateByList(currentState, nextTrees));
    setEditorMatches((currentState) => filterTreeStateByList(currentState, nextTrees));
    setSelectedEditorTargets((currentState) => filterTreeStateByList(currentState, nextTrees));
  };

  const setDescriptionEditing = (treeId, isEditing) => {
    setEditingDescriptions((currentState) => ({
      ...currentState,
      [treeId]: isEditing,
    }));
  };

  const setTreePendingState = (treeId, pendingKey, isPending) => {
    setRowPendingStates((currentState) => {
      const currentRowState = currentState[treeId] ?? {};
      const nextRowState = {
        ...currentRowState,
        [pendingKey]: isPending,
      };

      return {
        ...currentState,
        [treeId]: nextRowState,
      };
    });
  };

  const updateRowFeedback = (treeId, updates) => {
    setRowFeedback((currentState) => ({
      ...currentState,
      [treeId]: {
        ...(currentState[treeId] ?? {}),
        ...updates,
      },
    }));
  };

  const handleTransferQueryChange = (tree, nextValue) => {
    const treeId = String(tree.id);

    setTransferQueries((currentState) => ({
      ...currentState,
      [treeId]: nextValue,
    }));

    if (!String(nextValue ?? "").trim()) {
      setTransferMatches((currentState) => ({
        ...currentState,
        [treeId]: [],
      }));
      setSelectedTransferTargets((currentState) => ({
        ...currentState,
        [treeId]: getCurrentOwnerTransferTarget(tree),
      }));
      setTransferQueries((currentState) => ({
        ...currentState,
        [treeId]: getDefaultTransferQuery(tree),
      }));
    }
  };

  const handleEditorQueryChange = (treeId, nextValue) => {
    setEditorQueries((currentState) => ({
      ...currentState,
      [treeId]: nextValue,
    }));

    if (!String(nextValue ?? "").trim()) {
      setEditorMatches((currentState) => ({
        ...currentState,
        [treeId]: [],
      }));
      setSelectedEditorTargets((currentState) => ({
        ...currentState,
        [treeId]: null,
      }));
    }
  };

  const handleSearchTransferTargets = async (tree) => {
    const treeId = String(tree.id);
    const query = String(transferQueries[treeId] ?? "").trim();

    if (query.length < 2) {
      updateRowFeedback(treeId, {
        transferError: "Enter at least 2 characters to search for a new owner.",
        transferMessage: "",
      });
      return;
    }

    setTreePendingState(treeId, "transferSearch", true);
    setErrorMessage("");
    setStatusMessage("");
    updateRowFeedback(treeId, {
      transferError: "",
      transferMessage: "",
    });

    try {
      const response = await fetch("/api/trees", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "search-transfer-targets",
          query,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Transfer targets could not be searched");
      }

      const matches = Array.isArray(data?.matches) ? data.matches : [];

      setTransferMatches((currentState) => ({
        ...currentState,
        [treeId]: matches,
      }));
      setSelectedTransferTargets((currentState) => ({
        ...currentState,
        [treeId]: matches.find((entry) => String(entry?.objectId ?? "") === String(currentState[treeId]?.objectId ?? ""))
          ?? currentState[treeId]
          ?? getCurrentOwnerTransferTarget(tree),
      }));
      updateRowFeedback(treeId, {
        transferError: matches.length === 0 ? "No matching people were found." : "",
        transferMessage: matches.length > 0 ? `Found ${matches.length} possible owner${matches.length === 1 ? "" : "s"}.` : "",
      });
    } catch (error) {
      updateRowFeedback(treeId, {
        transferError: getErrorMessage(error, "Transfer targets could not be searched"),
        transferMessage: "",
      });
    } finally {
      setTreePendingState(treeId, "transferSearch", false);
    }
  };

  const handleTransferOwner = async (tree) => {
    const treeId = String(tree.id);
    const selectedTarget = selectedTransferTargets[treeId];

    if (!selectedTarget?.objectId) {
      updateRowFeedback(treeId, {
        transferError: "Select a person before transferring ownership.",
        transferMessage: "",
      });
      return;
    }

    const confirmMessage = tree.isPrivate
      ? `Transfer this private tree to ${selectedTarget.displayName}? You may lose access immediately if you are not also assigned as an editor.`
      : `Transfer this tree to ${selectedTarget.displayName}? Public visibility will stay unchanged, but only the owner and assigned editors can edit.`;

    if (!window.confirm(confirmMessage)) {
      return;
    }

    setTreePendingState(treeId, "transfer", true);
    setErrorMessage("");
    setStatusMessage("");
    updateRowFeedback(treeId, {
      transferError: "",
      transferMessage: "",
    });

    try {
      const response = await fetch("/api/trees", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "transfer-owner",
          treeId,
          targetOwnerObjectId: selectedTarget.objectId,
          visibility: visibilityFilter,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Ownership could not be transferred");
      }

      const nextTrees = Array.isArray(data?.trees) ? data.trees : [];
      const treeStillVisible = nextTrees.some((entry) => String(entry.id) === treeId);

      applyTreeList(nextTrees);
      setTransferQueries((currentState) => ({
        ...currentState,
        [treeId]: getDefaultTransferQuery(data?.updatedTree ?? tree),
      }));
      setTransferMatches((currentState) => ({
        ...currentState,
        [treeId]: [],
      }));
      setSelectedTransferTargets((currentState) => ({
        ...currentState,
        [treeId]: null,
      }));

      if (treeStillVisible) {
        updateRowFeedback(treeId, {
          transferError: "",
          transferMessage: `Owner updated to ${selectedTarget.displayName}.`,
        });
      } else {
        setStatusMessage(
          tree.isPrivate
            ? `Ownership transferred to ${selectedTarget.displayName}. This private tree is no longer visible to you.`
            : `Ownership transferred to ${selectedTarget.displayName}.`,
        );
      }
    } catch (error) {
      updateRowFeedback(treeId, {
        transferError: getErrorMessage(error, "Ownership could not be transferred"),
        transferMessage: "",
      });
    } finally {
      setTreePendingState(treeId, "transfer", false);
    }
  };

  const handleSearchEditorTargets = async (tree) => {
    const treeId = String(tree.id);
    const query = String(editorQueries[treeId] ?? "").trim();

    if (query.length < 2) {
      updateRowFeedback(treeId, {
        editorError: "Enter at least 2 characters to search for an editor.",
        editorMessage: "",
      });
      return;
    }

    setTreePendingState(treeId, "editorSearch", true);
    setErrorMessage("");
    setStatusMessage("");
    updateRowFeedback(treeId, {
      editorError: "",
      editorMessage: "",
    });

    try {
      const response = await fetch("/api/trees", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "search-editor-targets",
          query,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Editor targets could not be searched");
      }

      const matches = Array.isArray(data?.matches) ? data.matches : [];
      const nextOptions = buildEditorOptions(tree, matches);

      setEditorMatches((currentState) => ({
        ...currentState,
        [treeId]: nextOptions,
      }));
      setSelectedEditorTargets((currentState) => ({
        ...currentState,
        [treeId]: nextOptions.find((entry) => !entry.isCurrentOwner && !entry.isAssignedEditor)
          ?? nextOptions.find((entry) => String(entry?.objectId ?? "") === String(currentState[treeId]?.objectId ?? ""))
          ?? null,
      }));
      updateRowFeedback(treeId, {
        editorError: nextOptions.length === 0 ? "No matching people were found." : "",
        editorMessage: nextOptions.length > 0 ? `Found ${nextOptions.length} possible editor${nextOptions.length === 1 ? "" : "s"}.` : "",
      });
    } catch (error) {
      updateRowFeedback(treeId, {
        editorError: getErrorMessage(error, "Editor targets could not be searched"),
        editorMessage: "",
      });
    } finally {
      setTreePendingState(treeId, "editorSearch", false);
    }
  };

  const handleAddEditor = async (tree) => {
    const treeId = String(tree.id);
    const selectedTarget = selectedEditorTargets[treeId];

    if (!selectedTarget?.objectId) {
      updateRowFeedback(treeId, {
        editorError: "Select a person before adding an editor.",
        editorMessage: "",
      });
      return;
    }

    if (selectedTarget.isCurrentOwner) {
      updateRowFeedback(treeId, {
        editorError: "The owner already has access to this tree.",
        editorMessage: "",
      });
      return;
    }

    if (selectedTarget.isAssignedEditor) {
      updateRowFeedback(treeId, {
        editorError: `${selectedTarget.displayName} is already an editor for this tree.`,
        editorMessage: "",
      });
      return;
    }

    setTreePendingState(treeId, "editorAdd", true);
    setErrorMessage("");
    setStatusMessage("");
    updateRowFeedback(treeId, {
      editorError: "",
      editorMessage: "",
    });

    try {
      const response = await fetch("/api/trees", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "add-editor",
          treeId,
          targetOwnerObjectId: selectedTarget.objectId,
          visibility: visibilityFilter,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Editor could not be added");
      }

      applyTreeList(Array.isArray(data?.trees) ? data.trees : []);
      setEditorQueries((currentState) => ({
        ...currentState,
        [treeId]: "",
      }));
      setEditorMatches((currentState) => ({
        ...currentState,
        [treeId]: [],
      }));
      setSelectedEditorTargets((currentState) => ({
        ...currentState,
        [treeId]: null,
      }));
      updateRowFeedback(treeId, {
        editorError: "",
        editorMessage: `${selectedTarget.displayName} can now edit this tree.`,
      });
    } catch (error) {
      updateRowFeedback(treeId, {
        editorError: getErrorMessage(error, "Editor could not be added"),
        editorMessage: "",
      });
    } finally {
      setTreePendingState(treeId, "editorAdd", false);
    }
  };

  const handleRemoveEditor = async (tree, editor) => {
    const treeId = String(tree.id);
    const editorObjectId = String(editor?.objectId ?? "").trim();

    if (!editorObjectId) {
      return;
    }

    const confirmed = window.confirm(`Remove ${getEditorLabel(editor)} as an editor for "${tree.name}"?`);

    if (!confirmed) {
      return;
    }

    setTreePendingState(treeId, `editorRemove:${editorObjectId}`, true);
    setErrorMessage("");
    setStatusMessage("");
    updateRowFeedback(treeId, {
      editorError: "",
      editorMessage: "",
    });

    try {
      const response = await fetch("/api/trees", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "remove-editor",
          treeId,
          targetOwnerObjectId: editorObjectId,
          visibility: visibilityFilter,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Editor could not be removed");
      }

      applyTreeList(Array.isArray(data?.trees) ? data.trees : []);
      updateRowFeedback(treeId, {
        editorError: "",
        editorMessage: `${getEditorLabel(editor)} can no longer edit this tree.`,
      });
    } catch (error) {
      updateRowFeedback(treeId, {
        editorError: getErrorMessage(error, "Editor could not be removed"),
        editorMessage: "",
      });
    } finally {
      setTreePendingState(treeId, `editorRemove:${editorObjectId}`, false);
    }
  };

  useEffect(() => {
    if (!isVisibilityReady) {
      return;
    }

    let isMounted = true;

    async function loadTrees() {
      if (isMounted) {
        setIsLoading(true);
      }

      try {
        const response = await fetch(`/api/trees?visibility=${encodeURIComponent(visibilityFilter)}`, { cache: "no-store" });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data?.error || "Trees could not be loaded");
        }

        if (!isMounted) {
          return;
        }

        applyTreeList(Array.isArray(data) ? data : []);
        setErrorMessage("");
        setStatusMessage("");
      } catch (error) {
        if (isMounted) {
          setErrorMessage(getErrorMessage(error, "Trees could not be loaded"));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadTrees();

    return () => {
      isMounted = false;
    };
  }, [isVisibilityReady, visibilityFilter]);


  const handleCreateTree = async (event) => {
    event.preventDefault();

    const trimmedName = newTreeName.trim();
    if (!trimmedName) {
      return;
    }

    setIsCreating(true);
    setErrorMessage("");
    setStatusMessage("");

    try {
      const response = await fetch("/api/trees", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: trimmedName, visibility: visibilityFilter }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Tree could not be created");
      }

      applyTreeList(Array.isArray(data?.trees) ? data.trees : [], {
        resetNameTreeIds: [data?.createdTree?.id],
        resetDescriptionTreeIds: [data?.createdTree?.id],
      });
      if (!Array.isArray(data?.trees) || !data.trees.some((tree) => String(tree.id) === String(data?.createdTree?.id))) {
        setErrorMessage("Tree was created, but it is outside the current visibility filter.");
      }
      setNewTreeName("");
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Tree could not be created"));
    } finally {
      setIsCreating(false);
    }
  };

  const handleSaveTreeMeta = async (tree) => {
    const treeId = String(tree.id);
    const nextName = String(draftNames[treeId] ?? "").trim();
    const nextVisibility = draftVisibility[treeId] ?? (tree.isPrivate ? "private" : "public");
    const isPrivate = nextVisibility === "private";
    const isNameChanged = nextName !== tree.name;
    const isVisibilityChanged = isPrivate !== Boolean(tree.isPrivate);

    if (!nextName || (!isNameChanged && !isVisibilityChanged)) {
      return;
    }

    setTreePendingState(treeId, "meta", true);
    setErrorMessage("");
    setStatusMessage("");

    try {
      const response = await fetch("/api/trees", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          treeId,
          name: nextName,
          isPrivate,
          visibility: visibilityFilter,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Tree settings could not be updated");
      }

      applyTreeList(Array.isArray(data?.trees) ? data.trees : [], {
        resetNameTreeIds: [treeId],
        resetVisibilityTreeIds: [treeId],
      });

      if (!Array.isArray(data?.trees) || !data.trees.some((entry) => String(entry.id) === treeId)) {
        setErrorMessage("Tree settings were updated, but the tree is outside the current visibility filter.");
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Tree settings could not be updated"));
    } finally {
      setTreePendingState(treeId, "meta", false);
    }
  };

  const handleGenerateDescription = async (tree) => {
    const treeId = String(tree.id);

    setTreePendingState(treeId, "generate", true);
    setErrorMessage("");
    updateRowFeedback(treeId, {
      infoMessage: "",
      generateError: "",
      populateError: "",
      populateMessage: "",
      saveError: "",
      syncError: "",
      syncMessage: "",
    });

    try {
      const response = await fetch("/api/trees", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "generate-description",
          treeId,
          visibility: visibilityFilter,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Description draft could not be generated");
      }

      setDraftDescriptions((currentDrafts) => ({
        ...currentDrafts,
        [treeId]: String(data?.generatedDescription ?? ""),
      }));
      setDescriptionEditing(treeId, true);
      updateRowFeedback(treeId, {
        infoMessage: "Draft description generated. Review or edit it, then click Save to publish.",
        generateError: "",
        populateError: "",
        populateMessage: "",
        saveError: "",
        syncError: "",
        syncMessage: "",
      });
    } catch (error) {
      updateRowFeedback(treeId, {
        generateError: getErrorMessage(error, "Description draft could not be generated"),
      });
    } finally {
      setTreePendingState(treeId, "generate", false);
    }
  };

  const handleSaveDescription = async (tree) => {
    const treeId = String(tree.id);
    const nextDescription = String(draftDescriptions[treeId] ?? "");

    if (!nextDescription.trim()) {
      updateRowFeedback(treeId, {
        saveError: "Description is required before saving.",
      });
      return;
    }

    setTreePendingState(treeId, "save", true);
    setTreePendingState(treeId, "sync", true);
    setErrorMessage("");
    updateRowFeedback(treeId, {
      infoMessage: "",
      populateError: "",
      populateMessage: "",
      saveError: "",
      syncError: "",
      syncMessage: "",
    });

    try {
      const response = await fetch("/api/trees", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "save-description",
          treeId,
          description: nextDescription,
          visibility: visibilityFilter,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Description could not be saved");
      }

      applyTreeList(Array.isArray(data?.trees) ? data.trees : [], {
        resetDescriptionTreeIds: [treeId],
      });
      setDescriptionEditing(treeId, false);

      const syncStatus = data?.syncStatus ?? null;
      const syncError = formatSyncError(syncStatus);
      const syncMessage = syncStatus?.status === "success"
        ? formatPublishOutcomeMessage(syncStatus, treeId)
        : "";

      updateRowFeedback(treeId, {
        infoMessage: syncError
          ? "Description was saved, but the hosted-agent publish step did not complete."
          : "Description was saved.",
        populateError: "",
        populateMessage: "",
        saveError: "",
        syncError,
        syncMessage,
      });
    } catch (error) {
      updateRowFeedback(treeId, {
        saveError: getErrorMessage(error, "Description could not be saved"),
      });
    } finally {
      setTreePendingState(treeId, "save", false);
      setTreePendingState(treeId, "sync", false);
    }
  };

  const handleUnpublishDescription = async (tree) => {
    const treeId = String(tree.id);
    const hasSavedDescription = Boolean(normalizeComparableValue(tree.description));
    const isDescriptionPublished = Boolean(tree.isDescriptionPublished);

    if (!hasSavedDescription && !isDescriptionPublished) {
      return;
    }

    const confirmed = window.confirm(
      `Clear tree "${tree.name}"? This clears the saved description and unpublishes the tree from the agent before republishing the remaining tools.`,
    );

    if (!confirmed) {
      return;
    }

    setTreePendingState(treeId, "save", true);
    setTreePendingState(treeId, "sync", true);
    setErrorMessage("");
    updateRowFeedback(treeId, {
      infoMessage: "",
      populateError: "",
      populateMessage: "",
      saveError: "",
      syncError: "",
      syncMessage: "",
    });

    try {
      const response = await fetch("/api/trees", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "unpublish-description",
          treeId,
          visibility: visibilityFilter,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Description could not be cleared");
      }

      applyTreeList(Array.isArray(data?.trees) ? data.trees : [], {
        resetDescriptionTreeIds: [treeId],
      });
      setDescriptionEditing(treeId, false);

      const syncStatus = data?.syncStatus ?? null;
      const syncError = formatSyncError(syncStatus);

      updateRowFeedback(treeId, {
        infoMessage: syncError
          ? "Description was cleared, but the hosted-agent publish step did not complete."
          : "Description was cleared and removed from the agent.",
        populateError: "",
        populateMessage: "",
        saveError: "",
        syncError,
        syncMessage: "",
      });
    } catch (error) {
      updateRowFeedback(treeId, {
        saveError: getErrorMessage(error, "Description could not be cleared"),
      });
    } finally {
      setTreePendingState(treeId, "save", false);
      setTreePendingState(treeId, "sync", false);
    }
  };

  const handleCancelDescriptionDraft = (tree) => {
    const treeId = String(tree.id);
    const storedDescription = String(tree.description ?? "");

    setDraftDescriptions((currentDrafts) => ({
      ...currentDrafts,
      [treeId]: storedDescription,
    }));
    setDescriptionEditing(treeId, false);

    updateRowFeedback(treeId, {
      infoMessage: storedDescription
        ? "Saved description restored."
        : "Draft removed. This tree has no saved description yet.",
      generateError: "",
      populateError: "",
      populateMessage: "",
      saveError: "",
      syncError: "",
      syncMessage: "",
    });
  };

  const handlePopulateTree = async (tree) => {
    const treeId = String(tree.id);
    const storedDescription = String(tree.description ?? "");
    const draftDescription = String(draftDescriptions[treeId] ?? storedDescription);
    const isDescriptionChanged = normalizeComparableValue(draftDescription) !== normalizeComparableValue(storedDescription);

    if (!storedDescription.trim()) {
      updateRowFeedback(treeId, {
        populateError: "Save a description before populating this tree.",
        populateMessage: "",
      });
      return;
    }

    if (isDescriptionChanged) {
      updateRowFeedback(treeId, {
        populateError: "Save the current description draft before populating this tree.",
        populateMessage: "",
      });
      return;
    }

    const confirmed = window.confirm(
      `Populate tree \"${tree.name}\"? This will generate new data and insert it into the tree.`,
    );

    if (!confirmed) {
      return;
    }

    setTreePendingState(treeId, "populate", true);
    setErrorMessage("");
    updateRowFeedback(treeId, {
      populateError: "",
      populateMessage: "",
    });

    try {
      const response = await fetch("/api/trees/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ treeId }),
        body: JSON.stringify({ treeId, visibility: visibilityFilter }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Tree could not be populated");
      }

      applyTreeList(Array.isArray(data?.trees) ? data.trees : []);
      updateRowFeedback(treeId, {
        populateError: "",
        populateMessage: data?.message || "Tree content was appended successfully.",
      });
    } catch (error) {
      updateRowFeedback(treeId, {
        populateError: getErrorMessage(error, "Tree could not be populated"),
        populateMessage: "",
      });
    } finally {
      setTreePendingState(treeId, "populate", false);
    }
  };

  const handleDeleteTree = async (tree) => {
    const confirmed = window.confirm(`Delete tree \"${tree.name}\" and all its nodes and attachments?`);

    if (!confirmed) {
      return;
    }

    const treeId = String(tree.id);
    setTreePendingState(treeId, "delete", true);
    setErrorMessage("");

    try {
      const response = await fetch(`/api/trees?treeId=${encodeURIComponent(treeId)}&visibility=${encodeURIComponent(visibilityFilter)}`, {
        method: "DELETE",
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Tree could not be deleted");
      }

      applyTreeList(Array.isArray(data?.trees) ? data.trees : []);

      if (data?.syncStatus?.status === "failed") {
        setErrorMessage(
          `Tree was deleted, but the agent tool update did not complete: ${data.syncStatus.message || "Stored-description sync failed."}`,
        );
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Tree could not be deleted"));
    } finally {
      setTreePendingState(treeId, "delete", false);
    }
  };

  const handleToggleApprovalEnabled = async (tree) => {
    const treeId = String(tree.id);
    const nextApprovalEnabled = !Boolean(tree.approvalEnabled);

    if (!nextApprovalEnabled) {
      const confirmed = window.confirm(
        `Disable approvals for "${tree.name}"? This will reset the tree and its nodes and attachments back to draft.`,
      );

      if (!confirmed) {
        return;
      }
    }

    setTreePendingState(treeId, "approval", true);
    updateRowFeedback(treeId, {
      reviewError: "",
      reviewMessage: "",
    });
    setErrorMessage("");

    try {
      const response = await fetch("/api/trees", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "set-approval-enabled",
          treeId,
          approvalEnabled: nextApprovalEnabled,
          visibility: visibilityFilter,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Approval setting could not be updated");
      }

      applyTreeList(Array.isArray(data?.trees) ? data.trees : []);
      updateRowFeedback(treeId, {
        reviewError: "",
        reviewMessage: nextApprovalEnabled
          ? "Approval workflow enabled for this tree."
          : "Approval workflow disabled and all review states reset to draft.",
      });
    } catch (error) {
      updateRowFeedback(treeId, {
        reviewError: getErrorMessage(error, "Approval setting could not be updated"),
        reviewMessage: "",
      });
    } finally {
      setTreePendingState(treeId, "approval", false);
    }
  };

  const handleTreeReviewAction = async (tree, action) => {
    const treeId = String(tree.id);
    const treeScopeLabel = getTreeReviewScopeLabel(tree.name);
    const rejectionComment = action === "reject"
      ? promptForRejectionComment(treeScopeLabel)
      : null;

    if (action === "reject" && rejectionComment === null) {
      return;
    }

    const reviewActionLabel = action === "submit"
      ? `submit ${treeScopeLabel} for review`
      : action === "unsubmit"
        ? `move ${treeScopeLabel} back to draft`
      : action === "approve"
        ? `approve ${treeScopeLabel}`
        : `reject ${treeScopeLabel}`;

    if (!window.confirm(`Are you sure you want to ${reviewActionLabel}?`)) {
      return;
    }

    setTreePendingState(treeId, `review:${action}`, true);
    updateRowFeedback(treeId, {
      reviewError: "",
      reviewMessage: "",
    });
    setErrorMessage("");

    try {
      const response = await fetch("/api/trees", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          treeId,
          rejectionComment,
          visibility: visibilityFilter,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Tree review action could not be completed");
      }

      applyTreeList(Array.isArray(data?.trees) ? data.trees : []);
      updateRowFeedback(treeId, {
        reviewError: "",
        reviewMessage: action === "submit"
          ? "Tree submitted for review."
          : action === "unsubmit"
            ? "Tree moved back to draft."
          : action === "approve"
            ? "Tree approved."
            : "Tree rejected.",
      });
    } catch (error) {
      updateRowFeedback(treeId, {
        reviewError: getErrorMessage(error, "Tree review action could not be completed"),
        reviewMessage: "",
      });
    } finally {
      setTreePendingState(treeId, `review:${action}`, false);
    }
  };

  return (
    <main className={`${styles.pageShell} appPageShell`}>
      <section className={`appTopLevelPanel ${styles.heroCard}`}>
        <div className="appHeroCopy">
          <p className={`${styles.description} appPageDescription`}>
            Create new trees, manage visibility, maintain editor access, and submit entire trees for review. Only the owner can transfer ownership, change the editor list, or enable approvals, and only the owner or assigned editors can change tree content.
          </p>
        </div>

        <form onSubmit={handleCreateTree} className={styles.createForm}>
          <label className={styles.createField}>
            <span className="appFieldLabel">New tree name</span>
            <input
              type="text"
              value={newTreeName}
              onChange={(event) => setNewTreeName(event.target.value)}
              placeholder="Enter tree title"
              className={`appTextControl ${styles.textInput} ${styles.createTreeInput}`}
            />
          </label>
          <button
            type="submit"
            disabled={isCreating || !newTreeName.trim()}
            className={`appPrimaryFormButton ${styles.createButton}`}
          >
            {isCreating ? "Creating..." : "Create Tree"}
          </button>
        </form>
      </section>

      <section className={`appTopLevelPanel ${styles.listPanel}`}>
        <div className={`appPanelTopBar ${styles.listToolbar}`}>
          <span className={styles.panelHeading}>Current Trees</span>
          <label className={styles.toolbarLabel}>
            <select
              value={visibilityFilter}
              onChange={handleVisibilityFilterChange}
            >
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </label>
        </div>

        <div className={styles.listBody}>
          <h2 className={styles.sectionTitle}>{trees.length} tree{trees.length === 1 ? "" : "s"}</h2>
          <p className={styles.syncHint}>
            Trees without a saved description are not published to the agent.
          </p>
          {statusMessage ? <p className={styles.statusMessage}>{statusMessage}</p> : null}
          {errorMessage ? <p className={styles.errorMessage}>{errorMessage}</p> : null}

          {isLoading ? (
            <div className={styles.emptyState}>Loading trees...</div>
          ) : trees.length === 0 ? (
            <div className={styles.emptyState}>No trees exist for this application instance yet.</div>
          ) : (
            <div className={styles.treeList}>
              {trees.map((tree) => {
                const treeId = String(tree.id);
                const draftName = String(draftNames[treeId] ?? tree.name ?? "");
                const storedDescription = String(tree.description ?? "");
                const isDescriptionPublished = Boolean(tree.isDescriptionPublished);
                const draftDescription = String(draftDescriptions[treeId] ?? storedDescription);
                const rowPendingState = rowPendingStates[treeId] ?? {};
                const feedback = rowFeedback[treeId] ?? {};
                const isPending = Object.values(rowPendingState).some(Boolean);
                const isDescriptionEditing = Boolean(editingDescriptions[treeId]);
                const isNameChanged = draftName.trim() !== tree.name;
                const currentVisibility = tree.isPrivate ? "private" : "public";
                const nextVisibility = draftVisibility[treeId] ?? currentVisibility;
                const isVisibilityChanged = nextVisibility !== currentVisibility;
                const isDescriptionChanged = normalizeComparableValue(draftDescription) !== normalizeComparableValue(storedDescription);
                const hasSavedDescription = Boolean(normalizeComparableValue(storedDescription));
                const transferQuery = String(transferQueries[treeId] ?? "");
                const matches = Array.isArray(transferMatches[treeId]) ? transferMatches[treeId] : [];
                const selectedTransferTarget = selectedTransferTargets[treeId] ?? null;
                const transferOptions = buildTransferOptions(tree, matches);
                const editorQuery = String(editorQueries[treeId] ?? "");
                const editorOptions = Array.isArray(editorMatches[treeId]) ? editorMatches[treeId] : [];
                const selectedEditorTarget = selectedEditorTargets[treeId] ?? null;
                const currentEditors = Array.isArray(tree.editors) ? tree.editors : [];
                const canWriteTree = Boolean(tree.currentUserCanWrite);
                const canManageTreeAccess = Boolean(tree.currentUserCanManageAccess);
                const canReviewTree = Boolean(tree.currentUserCanReview);
                const approvalEnabled = Boolean(tree.approvalEnabled);
                const reviewStatus = String(tree.reviewStatus ?? "draft");
                const isTransferChanged = String(selectedTransferTarget?.objectId ?? "").trim() !== "" && String(selectedTransferTarget?.objectId ?? "").trim() !== String(tree.ownerObjectId ?? "").trim();
                const canSubmitTree = approvalEnabled && (reviewStatus === "draft" || reviewStatus === "rejected");
                const canApproveOrRejectTree = approvalEnabled && reviewStatus === "submitted";
                const canUnsubmitTree = approvalEnabled && reviewStatus === "submitted";

                return (
                  <article key={treeId} className={styles.treeRow}>
                    <div className={styles.rowSection}>
                      <div className={styles.treeMetaRow}>
                        <div className={styles.treeMetaHeader}>
                          <div className={styles.treeIdRow}>
                            <span className={styles.treeId}>Tree {treeId}</span>
                          </div>
                        </div>
                        <div className={styles.treeMeta}>
                          <div className={styles.treeMetaEditor}>
                            <div className={styles.treeVisibilityRow}>
                              <select
                                value={nextVisibility}
                                onChange={(event) => {
                                  const nextValue = event.target.value;
                                  setDraftVisibility((currentDrafts) => ({
                                    ...currentDrafts,
                                    [treeId]: nextValue,
                                  }));
                                }}
                                disabled={isPending || !canWriteTree}
                                className={`appSelectControl ${styles.treeVisibilitySelect}`}
                              >
                                <option value="public">Public</option>
                                <option value="private">Private</option>
                              </select>
                            </div>
                            <div className={styles.treeTitleRow}>
                              <input
                                type="text"
                                value={draftName}
                                onChange={(event) => {
                                  const nextValue = event.target.value;
                                  setDraftNames((currentDrafts) => ({
                                    ...currentDrafts,
                                    [treeId]: nextValue,
                                  }));
                                }}
                                disabled={isPending || !canWriteTree}
                                className={`appTextControl ${styles.textInput} ${styles.treeNameInput}`}
                              />
                              <button
                                type="button"
                                onClick={() => handleSaveTreeMeta(tree)}
                                disabled={isPending || !canWriteTree || !draftName.trim() || (!isNameChanged && !isVisibilityChanged)}
                                className="appCompactActionButton appCompactActionButtonNeutral"
                              >
                                {rowPendingState.meta ? "Saving..." : "Save"}
                              </button>
                            </div>
                          </div>
                          <div className={styles.treeMetaActions}>
                            <button
                              type="button"
                              onClick={() => handlePopulateTree(tree)}
                              disabled={!canWriteTree || Boolean(rowPendingState.generate) || Boolean(rowPendingState.populate) || Boolean(rowPendingState.save) || Boolean(rowPendingState.sync) || Boolean(rowPendingState.meta) || !hasSavedDescription || isDescriptionChanged}
                              className="appCompactActionButton appCompactActionButtonNeutral"
                            >
                              {rowPendingState.populate ? "Populating..." : "Populate"}
                            </button>
                            <Link
                              href={buildVisibilityHref(
                                "/notes",
                                `treeId=${encodeURIComponent(treeId)}`,
                                visibilityFilter,
                                PUBLIC_PRIVATE_VISIBILITY_VALUES,
                              )}
                              className={`appCompactActionButton ${styles.actionButtonLink}`}
                            >
                              Open
                            </Link>
                            <button
                              type="button"
                              onClick={() => handleDeleteTree(tree)}
                              disabled={isPending || !canWriteTree}
                              className="appCompactActionButton appCompactActionButtonDanger"
                            >
                              {rowPendingState.delete ? "Working..." : "Delete"}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className={styles.descriptionRow}>
                        <div className={styles.descriptionBlock}>
                          <div className={styles.descriptionFieldRow}>
                            <div className={styles.descriptionHeaderRow}>
                              <span className={`${styles.descriptionLabel} appFieldLabel`}>Description</span>
                              <span className={styles.descriptionContextLabel}>(used by agent)</span>
                              {isDescriptionChanged || storedDescription ? (
                                <div className={styles.descriptionBadgeRow}>
                                  {isDescriptionChanged ? (
                                    <span className={styles.draftBadge}>Unsaved draft</span>
                                  ) : null}
                                  {storedDescription ? (
                                    <>
                                      <span className={styles.savedBadge}>Saved</span>
                                      {isDescriptionPublished ? (
                                        <span className={styles.agentBadge}>Published to agent</span>
                                      ) : null}
                                    </>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                            {isDescriptionEditing ? (
                              <textarea
                                value={draftDescription}
                                onChange={(event) => {
                                  const nextValue = event.target.value;
                                  setDraftDescriptions((currentDrafts) => ({
                                    ...currentDrafts,
                                    [treeId]: nextValue,
                                  }));
                                }}
                                disabled={!canWriteTree || Boolean(rowPendingState.save) || Boolean(rowPendingState.sync)}
                                placeholder="Generate a draft or write a tree description manually"
                                className={`appTextAreaControl ${styles.descriptionInput}`}
                                rows={4}
                              />
                            ) : (
                              <div className={`${styles.descriptionPreview} ${!draftDescription.trim() ? styles.descriptionPreviewEmpty : ""}`}>
                                {draftDescription.trim() || "No summary saved yet."}
                              </div>
                            )}
                          </div>

                          {feedback.infoMessage ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackInfo}`}>{feedback.infoMessage}</p>
                          ) : null}
                          {feedback.generateError ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackError}`}>{feedback.generateError}</p>
                          ) : null}
                          {feedback.saveError ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackError}`}>{feedback.saveError}</p>
                          ) : null}
                          {feedback.populateMessage ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackSuccess}`}>{feedback.populateMessage}</p>
                          ) : null}
                          {feedback.populateError ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackError}`}>{feedback.populateError}</p>
                          ) : null}
                          {feedback.syncMessage ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackSuccess}`}>{feedback.syncMessage}</p>
                          ) : null}
                          {feedback.syncError ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackWarning}`}>{feedback.syncError}</p>
                          ) : null}
                        </div>

                        <div className={styles.rowActions}>
                          <button
                            type="button"
                            onClick={() => setDescriptionEditing(treeId, true)}
                            disabled={isPending || !canWriteTree || isDescriptionEditing}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleGenerateDescription(tree)}
                            disabled={!canWriteTree || Boolean(rowPendingState.generate) || Boolean(rowPendingState.populate) || Boolean(rowPendingState.save) || Boolean(rowPendingState.sync)}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                          >
                            {rowPendingState.generate ? "Generating..." : "Generate"}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSaveDescription(tree)}
                            disabled={!canWriteTree || Boolean(rowPendingState.populate) || Boolean(rowPendingState.save) || Boolean(rowPendingState.sync) || !draftDescription.trim() || !isDescriptionChanged}
                            className="appCompactActionButton appCompactActionButtonPrimary"
                          >
                            {rowPendingState.save ? "Saving..." : rowPendingState.sync ? "Syncing..." : "Save"}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleUnpublishDescription(tree)}
                            disabled={!canWriteTree || Boolean(rowPendingState.generate) || Boolean(rowPendingState.populate) || Boolean(rowPendingState.save) || Boolean(rowPendingState.sync) || (!hasSavedDescription && !isDescriptionPublished)}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                          >
                            {rowPendingState.save ? "Working..." : "Clear"}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCancelDescriptionDraft(tree)}
                            disabled={isPending || (!isDescriptionChanged && !isDescriptionEditing)}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>

                      <div className={styles.transferRow}>
                        <div className={styles.transferBlock}>
                          <div className={styles.transferHeader}>
                            <span className={`${styles.transferLabel} appFieldLabel`}>Review</span>
                            <span className={styles.transferHint}>Approval applies to the entire tree here and gates Review-page visibility for this tree and its child content.</span>
                          </div>
                          <div className={styles.reviewSectionBody}>
                            <div className={styles.reviewSummaryRow}>
                              <label className={styles.reviewToggle}>
                                <input
                                  type="checkbox"
                                  checked={approvalEnabled}
                                  onChange={() => handleToggleApprovalEnabled(tree)}
                                  disabled={isPending || !canManageTreeAccess}
                                />
                                <span>Approval enabled</span>
                              </label>
                              {approvalEnabled ? (
                                <>
                                  <span className={`${styles.reviewStatusBadge} ${getReviewStatusClassName(reviewStatus, styles)}`}>
                                    {formatReviewStatusLabel(reviewStatus)}
                                  </span>
                                  <span className={styles.reviewMeta}>{formatReviewAuditLabel(tree)}</span>
                                </>
                              ) : null}
                            </div>
                            {approvalEnabled ? (
                              <div className={styles.reviewActionRow}>
                                {canSubmitTree ? (
                                  <button
                                    type="button"
                                    onClick={() => handleTreeReviewAction(tree, "submit")}
                                    disabled={isPending || !canReviewTree}
                                    className="appCompactActionButton appCompactActionButtonNeutral"
                                  >
                                    {rowPendingState["review:submit"] ? "Submitting..." : "Submit"}
                                  </button>
                                ) : null}
                                {canUnsubmitTree ? (
                                  <button
                                    type="button"
                                    onClick={() => handleTreeReviewAction(tree, "unsubmit")}
                                    disabled={isPending || !canReviewTree}
                                    className="appCompactActionButton appCompactActionButtonNeutral"
                                  >
                                    {rowPendingState["review:unsubmit"] ? "Unsubmitting..." : "Unsubmit"}
                                  </button>
                                ) : null}
                                {canApproveOrRejectTree ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => handleTreeReviewAction(tree, "approve")}
                                      disabled={isPending || !canReviewTree}
                                      className="appCompactActionButton appCompactActionButtonPrimary"
                                    >
                                      {rowPendingState["review:approve"] ? "Approving..." : "Approve"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleTreeReviewAction(tree, "reject")}
                                      disabled={isPending || !canReviewTree}
                                      className="appCompactActionButton appCompactActionButtonDanger"
                                    >
                                      {rowPendingState["review:reject"] ? "Rejecting..." : "Reject"}
                                    </button>
                                  </>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                          {!approvalEnabled ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackInfo}`}>Approval is disabled. This tree and its child content stay in draft and do not appear on the Review page.</p>
                          ) : null}
                          {!canManageTreeAccess ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackInfo}`}>Only the owner can enable or disable approvals for this tree.</p>
                          ) : null}
                          {feedback.reviewMessage ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackSuccess}`}>{feedback.reviewMessage}</p>
                          ) : null}
                          {feedback.reviewError ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackError}`}>{feedback.reviewError}</p>
                          ) : null}
                        </div>
                      </div>

                      <div className={styles.transferRow}>
                        <div className={styles.transferBlock}>
                          <div className={styles.transferHeader}>
                            <span className={`${styles.transferLabel} appFieldLabel`}>Owner</span>
                            <span className={styles.transferHint}>
                              {canManageTreeAccess
                                ? "Only the owner can transfer ownership or manage editors."
                                : "Only the owner can transfer ownership."}
                            </span>
                          </div>
                          <div className={styles.transferControls}>
                            <input
                              type="text"
                              value={transferQuery}
                              onChange={(event) => handleTransferQueryChange(tree, event.target.value)}
                              disabled={isPending || !canManageTreeAccess}
                              placeholder="Search by name or email"
                              className={`appTextControl ${styles.textInput} ${styles.transferInput}`}
                            />
                            <button
                              type="button"
                              onClick={() => handleSearchTransferTargets(tree)}
                              disabled={isPending || !canManageTreeAccess || transferQuery.trim().length < 2}
                              className="appCompactActionButton appCompactActionButtonNeutral"
                            >
                              {rowPendingState.transferSearch ? "Searching..." : "Search"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleTransferOwner(tree)}
                              disabled={isPending || !canManageTreeAccess || !isTransferChanged}
                              className="appCompactActionButton appCompactActionButtonNeutral"
                            >
                              {rowPendingState.transfer ? "Transferring..." : "Transfer owner"}
                            </button>
                          </div>
                          {!canManageTreeAccess ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackInfo}`}>You can view owner details, but only the owner can change ownership.</p>
                          ) : null}
                          {matches.length > 0 ? (
                            <div className={styles.transferResults}>
                              {transferOptions.map((match) => {
                                const optionId = `${treeId}-${match.objectId}`;
                                const isSelected = String(selectedTransferTarget?.objectId ?? "") === String(match.objectId ?? "");

                                return (
                                  <label key={optionId} className={`${styles.transferOption} ${isSelected ? styles.transferOptionSelected : ""}`}>
                                    <input
                                      type="radio"
                                      name={`transfer-target-${treeId}`}
                                      checked={isSelected}
                                      onChange={() => {
                                        setSelectedTransferTargets((currentState) => ({
                                          ...currentState,
                                          [treeId]: match,
                                        }));
                                        setTransferQueries((currentState) => ({
                                          ...currentState,
                                          [treeId]: getTransferTargetLabel(match),
                                        }));
                                      }}
                                      disabled={isPending || !canManageTreeAccess}
                                    />
                                    <span className={styles.transferOptionText}>
                                      <span className={styles.transferOptionTitle}>
                                        {match.displayName}
                                        {match.isCurrentOwner ? <span className={styles.transferCurrentBadge}>Current owner</span> : null}
                                      </span>
                                      <span className={styles.transferOptionMeta}>{match.userDetails}</span>
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          ) : null}
                          {feedback.transferMessage ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackSuccess}`}>{feedback.transferMessage}</p>
                          ) : null}
                          {feedback.transferError ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackError}`}>{feedback.transferError}</p>
                          ) : null}
                        </div>
                      </div>

                      <div className={styles.transferRow}>
                        <div className={styles.transferBlock}>
                          <div className={styles.transferHeader}>
                            <span className={`${styles.transferLabel} appFieldLabel`}>Editors</span>
                            <span className={styles.transferHint}>
                              {tree.isPrivate
                                ? "Editors can open and change this private tree."
                                : "Editors can change this tree even when it is publicly visible."}
                            </span>
                          </div>
                          <div className={styles.editorList}>
                            {currentEditors.length > 0 ? currentEditors.map((editor) => {
                              const editorObjectId = String(editor?.objectId ?? "");
                              const removePendingKey = `editorRemove:${editorObjectId}`;

                              return (
                                <div key={`${treeId}-editor-${editorObjectId}`} className={styles.editorCard}>
                                  <div className={styles.editorCardText}>
                                    <span className={styles.editorCardTitle}>{getEditorLabel(editor)}</span>
                                    <span className={styles.editorCardMeta}>{editor.userDetails || editor.objectId}</span>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveEditor(tree, editor)}
                                    disabled={isPending || !canManageTreeAccess || Boolean(rowPendingState[removePendingKey])}
                                    className="appCompactActionButton appCompactActionButtonNeutral"
                                  >
                                    {rowPendingState[removePendingKey] ? "Removing..." : "Remove"}
                                  </button>
                                </div>
                              );
                            }) : (
                              <p className={styles.emptyEditors}>No editors have been assigned yet.</p>
                            )}
                          </div>
                          <div className={styles.transferControls}>
                            <input
                              type="text"
                              value={editorQuery}
                              onChange={(event) => handleEditorQueryChange(treeId, event.target.value)}
                              disabled={isPending || !canManageTreeAccess}
                              placeholder="Search by name or email"
                              className={`appTextControl ${styles.textInput} ${styles.transferInput}`}
                            />
                            <button
                              type="button"
                              onClick={() => handleSearchEditorTargets(tree)}
                              disabled={isPending || !canManageTreeAccess || editorQuery.trim().length < 2}
                              className="appCompactActionButton appCompactActionButtonNeutral"
                            >
                              {rowPendingState.editorSearch ? "Searching..." : "Search"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAddEditor(tree)}
                              disabled={isPending || !canManageTreeAccess || !selectedEditorTarget?.objectId || selectedEditorTarget?.isCurrentOwner || selectedEditorTarget?.isAssignedEditor}
                              className="appCompactActionButton appCompactActionButtonNeutral"
                            >
                              {rowPendingState.editorAdd ? "Adding..." : "Add editor"}
                            </button>
                          </div>
                          {!canManageTreeAccess ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackInfo}`}>You can see who can edit this tree, but only the owner can change the editor list.</p>
                          ) : null}
                          {editorOptions.length > 0 ? (
                            <div className={styles.transferResults}>
                              {editorOptions.map((match) => {
                                const optionId = `${treeId}-editor-option-${match.objectId}`;
                                const isSelected = String(selectedEditorTarget?.objectId ?? "") === String(match.objectId ?? "");

                                return (
                                  <label key={optionId} className={`${styles.transferOption} ${isSelected ? styles.transferOptionSelected : ""}`}>
                                    <input
                                      type="radio"
                                      name={`editor-target-${treeId}`}
                                      checked={isSelected}
                                      onChange={() => {
                                        setSelectedEditorTargets((currentState) => ({
                                          ...currentState,
                                          [treeId]: match,
                                        }));
                                        setEditorQueries((currentState) => ({
                                          ...currentState,
                                          [treeId]: getTransferTargetLabel(match),
                                        }));
                                      }}
                                      disabled={isPending || !canManageTreeAccess}
                                    />
                                    <span className={styles.transferOptionText}>
                                      <span className={styles.transferOptionTitle}>
                                        {match.displayName}
                                        {match.isCurrentOwner ? <span className={styles.transferCurrentBadge}>Owner</span> : null}
                                        {match.isAssignedEditor ? <span className={styles.transferCurrentBadge}>Editor</span> : null}
                                      </span>
                                      <span className={styles.transferOptionMeta}>{match.userDetails}</span>
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          ) : null}
                          {feedback.editorMessage ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackSuccess}`}>{feedback.editorMessage}</p>
                          ) : null}
                          {feedback.editorError ? (
                            <p className={`${styles.rowFeedback} ${styles.rowFeedbackError}`}>{feedback.editorError}</p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

export default function TreesPage() {
  return (
    <Suspense fallback={<main className="appPageShell">Loading...</main>}>
      <TreesPageContent />
    </Suspense>
  );
}