"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "./page.module.css";

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

export default function TreesPage() {
  const [trees, setTrees] = useState([]);
  const [draftNames, setDraftNames] = useState({});
  const [draftVisibility, setDraftVisibility] = useState({});
  const [draftDescriptions, setDraftDescriptions] = useState({});
  const [editingDescriptions, setEditingDescriptions] = useState({});
  const [newTreeName, setNewTreeName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [visibilityFilter, setVisibilityFilter] = useState("public");
  const [isCreating, setIsCreating] = useState(false);
  const [rowPendingStates, setRowPendingStates] = useState({});
  const [rowFeedback, setRowFeedback] = useState({});
  const [errorMessage, setErrorMessage] = useState("");

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

  useEffect(() => {
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
  }, [visibilityFilter]);

  const handleCreateTree = async (event) => {
    event.preventDefault();

    const trimmedName = newTreeName.trim();
    if (!trimmedName) {
      return;
    }

    setIsCreating(true);
    setErrorMessage("");

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

  return (
    <main className={`${styles.pageShell} appPageShell`}>
      <section className={`appTopLevelPanel ${styles.heroCard}`}>
        <div className="appHeroCopy">
          <p className={`${styles.description} appPageDescription`}>
            Create new trees, rename existing titles, and remove trees that should no longer be part of this application instance.
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
              onChange={(event) => setVisibilityFilter(event.target.value)}
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

                return (
                  <article key={treeId} className={styles.treeRow}>
                    <div className={styles.rowSection}>
                      <div className={styles.treeMetaRow}>
                        <div className={styles.treeMeta}>
                          <span className={styles.treeId}>Tree {treeId}</span>
                          <div className={styles.treeMetaEditor}>
                            <select
                              value={nextVisibility}
                              onChange={(event) => {
                                const nextValue = event.target.value;
                                setDraftVisibility((currentDrafts) => ({
                                  ...currentDrafts,
                                  [treeId]: nextValue,
                                }));
                              }}
                              disabled={isPending}
                              className={`appSelectControl ${styles.treeVisibilitySelect}`}
                            >
                              <option value="public">Public</option>
                              <option value="private">Private</option>
                            </select>
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
                              disabled={isPending}
                              className={`appTextControl ${styles.textInput} ${styles.treeNameInput}`}
                            />
                          </div>
                        </div>

                        <div className={styles.rowActions}>
                          <button
                            type="button"
                            onClick={() => handleSaveTreeMeta(tree)}
                            disabled={isPending || !draftName.trim() || (!isNameChanged && !isVisibilityChanged)}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                          >
                            {rowPendingState.meta ? "Saving..." : "Save"}
                          </button>
                          <button
                            type="button"
                            onClick={() => handlePopulateTree(tree)}
                            disabled={Boolean(rowPendingState.generate) || Boolean(rowPendingState.populate) || Boolean(rowPendingState.save) || Boolean(rowPendingState.sync) || Boolean(rowPendingState.meta) || !hasSavedDescription || isDescriptionChanged}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                          >
                            {rowPendingState.populate ? "Populating..." : "Populate"}
                          </button>
                          <Link
                            href={`/notes?treeId=${encodeURIComponent(treeId)}${visibilityFilter === "public" ? "" : `&visibility=${encodeURIComponent(visibilityFilter)}`}`}
                            className={`appCompactActionButton ${styles.actionButtonLink}`}
                          >
                            Open
                          </Link>
                          <button
                            type="button"
                            onClick={() => handleDeleteTree(tree)}
                            disabled={isPending}
                            className="appCompactActionButton appCompactActionButtonDanger"
                          >
                            {rowPendingState.delete ? "Working..." : "Delete"}
                          </button>
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
                                disabled={Boolean(rowPendingState.save) || Boolean(rowPendingState.sync)}
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
                            disabled={isPending || isDescriptionEditing}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleGenerateDescription(tree)}
                            disabled={Boolean(rowPendingState.generate) || Boolean(rowPendingState.populate) || Boolean(rowPendingState.save) || Boolean(rowPendingState.sync)}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                          >
                            {rowPendingState.generate ? "Generating..." : "Generate"}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSaveDescription(tree)}
                            disabled={Boolean(rowPendingState.populate) || Boolean(rowPendingState.save) || Boolean(rowPendingState.sync) || !draftDescription.trim() || !isDescriptionChanged}
                            className="appCompactActionButton appCompactActionButtonPrimary"
                          >
                            {rowPendingState.save ? "Saving..." : rowPendingState.sync ? "Syncing..." : "Save"}
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