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

export default function TreesPage() {
  const [trees, setTrees] = useState([]);
  const [draftNames, setDraftNames] = useState({});
  const [newTreeName, setNewTreeName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [pendingTreeId, setPendingTreeId] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");

  const applyTreeList = (nextTrees) => {
    setTrees(nextTrees);
    setDraftNames(buildDraftNames(nextTrees));
  };

  useEffect(() => {
    let isMounted = true;

    async function loadTrees() {
      try {
        const response = await fetch("/api/trees", { cache: "no-store" });
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
  }, []);

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
        body: JSON.stringify({ name: trimmedName }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Tree could not be created");
      }

      applyTreeList(Array.isArray(data?.trees) ? data.trees : []);
      setNewTreeName("");
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Tree could not be created"));
    } finally {
      setIsCreating(false);
    }
  };

  const handleRenameTree = async (tree) => {
    const treeId = String(tree.id);
    const nextName = String(draftNames[treeId] ?? "").trim();

    if (!nextName || nextName === tree.name) {
      return;
    }

    setPendingTreeId(treeId);
    setErrorMessage("");

    try {
      const response = await fetch("/api/trees", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ treeId, name: nextName }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Tree title could not be updated");
      }

      applyTreeList(Array.isArray(data?.trees) ? data.trees : []);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Tree title could not be updated"));
    } finally {
      setPendingTreeId(null);
    }
  };

  const handleDeleteTree = async (tree) => {
    const confirmed = window.confirm(`Delete tree \"${tree.name}\" and all its nodes and attachments?`);

    if (!confirmed) {
      return;
    }

    const treeId = String(tree.id);
    setPendingTreeId(treeId);
    setErrorMessage("");

    try {
      const response = await fetch(`/api/trees?treeId=${encodeURIComponent(treeId)}`, {
        method: "DELETE",
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Tree could not be deleted");
      }

      applyTreeList(Array.isArray(data?.trees) ? data.trees : []);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Tree could not be deleted"));
    } finally {
      setPendingTreeId(null);
    }
  };

  return (
    <main className={styles.pageShell}>
      <section className={`appTopLevelPanel ${styles.heroCard}`}>
        <div className={styles.heroCopy}>
          <p className={styles.description}>
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
          <div>
            <p className={styles.sectionEyebrow}>Current trees</p>
            <h2 className={styles.sectionTitle}>{trees.length} tree{trees.length === 1 ? "" : "s"}</h2>
          </div>
        </div>

        <div className={styles.listBody}>
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
                const isPending = pendingTreeId === treeId;
                const isNameChanged = draftName.trim() !== tree.name;

                return (
                  <article key={treeId} className={styles.treeRow}>
                    <div className={styles.treeMeta}>
                      <span className={styles.treeId}>Tree {treeId}</span>
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

                    <div className={styles.rowActions}>
                      <Link
                        href={`/notes?treeId=${encodeURIComponent(treeId)}`}
                        className={`appCompactActionButton ${styles.actionButtonLink}`}
                      >
                        Open
                      </Link>
                      <button
                        type="button"
                        onClick={() => handleRenameTree(tree)}
                        disabled={isPending || !draftName.trim() || !isNameChanged}
                        className="appCompactActionButton appCompactActionButtonNeutral"
                      >
                        {isPending ? "Saving..." : "Save Title"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteTree(tree)}
                        disabled={isPending}
                        className="appCompactActionButton appCompactActionButtonDanger"
                      >
                        {isPending ? "Working..." : "Delete"}
                      </button>
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