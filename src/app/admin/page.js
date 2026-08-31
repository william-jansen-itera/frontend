"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/app/useAuth";
import { hasClientPrincipalRole } from "@/shared/clientPrincipal";
import styles from "./page.module.css";

const INDEXING_COLUMNS = [
  { key: "incremental", label: "incremental" },
  { key: "full", label: "full" },
];

const INDEXING_ROWS = [
  { key: "node-data", label: "node data" },
  { key: "blob-content", label: "attachment content" },
  { key: "all", label: "all" },
];

function getErrorMessage(error, fallbackMessage) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallbackMessage;
}

function formatTimestamp(value) {
  if (!value) {
    return "Unknown time";
  }

  const parsedValue = new Date(value);

  if (Number.isNaN(parsedValue.getTime())) {
    return "Unknown time";
  }

  return parsedValue.toLocaleString();
}

function formatIndexingResultMessage(result) {
  const targetLabel = INDEXING_ROWS.find((row) => row.key === result?.target)?.label || "indexing";
  const modeLabel = result?.mode === "full" ? "Full" : "Incremental";
  const operations = Array.isArray(result?.operations) ? result.operations : [];

  if (operations.length === 0) {
    return `${modeLabel} ${targetLabel} indexing request was accepted.`;
  }

  const summary = operations
    .map((operation) => `${operation.operation} ${operation.indexerName} (${operation.status})`)
    .join(", ");

  return `${modeLabel} ${targetLabel} indexing started: ${summary}.`;
}

function formatIndexingErrorMessage(result, fallbackMessage) {
  const baseMessage = String(result?.error || fallbackMessage || "Indexing request failed").trim();
  const operations = Array.isArray(result?.operations) ? result.operations : [];
  const failedOperations = Array.isArray(result?.failedOperations) ? result.failedOperations : [];
  const detailParts = [];

  if (operations.length > 0) {
    detailParts.push(`completed ${operations.map((operation) => `${operation.operation} ${operation.indexerName} (${operation.status})`).join(", ")}`);
  }

  if (failedOperations.length > 0) {
    detailParts.push(`failed ${failedOperations.map((operation) => `${operation.operation} ${operation.indexerName}${operation.error ? `: ${operation.error}` : ""}`).join(", ")}`);
  }

  return detailParts.length > 0 ? `${baseMessage} (${detailParts.join("; ")})` : baseMessage;
}

export default function AdminPage() {
  const { user } = useAuth();
  const isAdmin = hasClientPrincipalRole(user, "mdsadmin");
  const [deletedTrees, setDeletedTrees] = useState([]);
  const [deletedNodes, setDeletedNodes] = useState([]);
  const [deletedAttachments, setDeletedAttachments] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [pendingItems, setPendingItems] = useState({});

  const setPending = (key, isPending) => {
    setPendingItems((current) => ({
      ...current,
      [key]: isPending,
    }));
  };

  const loadDeletedItems = async () => {
    if (!isAdmin) {
      setDeletedTrees([]);
      setDeletedNodes([]);
      setDeletedAttachments([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch("/api/admin/deleted", { cache: "no-store" });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Deleted items could not be loaded");
      }

      setDeletedTrees(Array.isArray(data?.deletedTrees) ? data.deletedTrees : []);
      setDeletedNodes(Array.isArray(data?.deletedNodes) ? data.deletedNodes : []);
      setDeletedAttachments(Array.isArray(data?.deletedAttachments) ? data.deletedAttachments : []);
      setErrorMessage("");
    } catch (error) {
      setDeletedTrees([]);
      setDeletedNodes([]);
      setDeletedAttachments([]);
      setErrorMessage(getErrorMessage(error, "Deleted items could not be loaded"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    let isMounted = true;

    if (!isAdmin) {
      return () => {
        isMounted = false;
      };
    }

    Promise.resolve().then(async () => {
      try {
        const response = await fetch("/api/admin/deleted", { cache: "no-store" });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data?.error || "Deleted items could not be loaded");
        }

        if (!isMounted) {
          return;
        }

        setDeletedTrees(Array.isArray(data?.deletedTrees) ? data.deletedTrees : []);
        setDeletedNodes(Array.isArray(data?.deletedNodes) ? data.deletedNodes : []);
        setDeletedAttachments(Array.isArray(data?.deletedAttachments) ? data.deletedAttachments : []);
        setErrorMessage("");
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setDeletedTrees([]);
        setDeletedNodes([]);
        setDeletedAttachments([]);
        setErrorMessage(getErrorMessage(error, "Deleted items could not be loaded"));
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    });

    return () => {
      isMounted = false;
    };
  }, [isAdmin]);

  const handlePurgeTree = async (tree) => {
    const treeId = String(tree.id);
    const confirmed = window.confirm(`Purge tree "${tree.name}" permanently? This cannot be undone.`);

    if (!confirmed) {
      return;
    }

    setPending(`tree:${treeId}`, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch(`/api/trees?treeId=${encodeURIComponent(treeId)}&purge=true&visibility=both`, {
        method: "DELETE",
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Tree could not be purged");
      }

      setStatusMessage(`Tree ${treeId} was purged.`);
      await loadDeletedItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Tree could not be purged"));
    } finally {
      setPending(`tree:${treeId}`, false);
    }
  };

  const handleUndeleteTree = async (tree) => {
    const treeId = String(tree.id);

    setPending(`undelete-tree:${treeId}`, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/admin/deleted", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "undelete-tree", treeId }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Tree could not be undeleted");
      }

      setStatusMessage(`Tree ${treeId} was undeleted.`);
      await loadDeletedItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Tree could not be undeleted"));
    } finally {
      setPending(`undelete-tree:${treeId}`, false);
    }
  };

  const handlePurgeAllTrees = async () => {
    if (deletedTrees.length === 0) {
      return;
    }

    const confirmed = window.confirm("Purge all deleted trees permanently? This will also remove all remaining nodes and attachments under those trees.");

    if (!confirmed) {
      return;
    }

    setPending("bulk:trees", true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/admin/deleted", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "purge-all-trees" }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Deleted trees could not be purged");
      }

      setStatusMessage(`Purged ${data?.purgedTreeCount ?? 0} deleted tree${Number(data?.purgedTreeCount ?? 0) === 1 ? "" : "s"}.`);
      await loadDeletedItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Deleted trees could not be purged"));
    } finally {
      setPending("bulk:trees", false);
    }
  };

  const handlePurgeNode = async (node) => {
    const treeId = String(node.treeId);
    const nodeId = String(node.nodeId);
    const confirmed = window.confirm(`Purge node "${node.title}" from tree "${node.treeDisplayName}" permanently? This cannot be undone.`);

    if (!confirmed) {
      return;
    }

    setPending(`node:${node.id}`, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch(`/api/notes?treeId=${encodeURIComponent(treeId)}&id=${encodeURIComponent(nodeId)}&purge=true`, {
        method: "DELETE",
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Node could not be purged");
      }

      setStatusMessage(`Node ${nodeId} in tree ${treeId} was purged.`);
      await loadDeletedItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Node could not be purged"));
    } finally {
      setPending(`node:${node.id}`, false);
    }
  };

  const handleUndeleteNode = async (node) => {
    const treeId = String(node.treeId);
    const nodeId = String(node.nodeId);

    setPending(`undelete-node:${node.id}`, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/admin/deleted", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "undelete-node", treeId, nodeId }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Node could not be undeleted");
      }

      setStatusMessage(`Node ${nodeId} in tree ${treeId} was undeleted.`);
      await loadDeletedItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Node could not be undeleted"));
    } finally {
      setPending(`undelete-node:${node.id}`, false);
    }
  };

  const handlePurgeAllNodes = async () => {
    if (deletedNodes.length === 0) {
      return;
    }

    const confirmed = window.confirm("Purge all deleted nodes permanently? This cannot be undone.");

    if (!confirmed) {
      return;
    }

    setPending("bulk:nodes", true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/admin/deleted", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "purge-all-nodes" }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Deleted nodes could not be purged");
      }

      setStatusMessage(`Purged ${data?.purgedNodeCount ?? 0} deleted node${Number(data?.purgedNodeCount ?? 0) === 1 ? "" : "s"}.`);
      await loadDeletedItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Deleted nodes could not be purged"));
    } finally {
      setPending("bulk:nodes", false);
    }
  };

  const handleUndeleteAttachment = async (attachment) => {
    const treeId = String(attachment.treeId);
    const attachmentId = String(attachment.id);

    setPending(`undelete-attachment:${attachmentId}`, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/admin/deleted", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "undelete-attachment", treeId, attachmentId }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Attachment could not be undeleted");
      }

      setStatusMessage(`Attachment ${attachmentId} in tree ${treeId} was undeleted.`);
      await loadDeletedItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Attachment could not be undeleted"));
    } finally {
      setPending(`undelete-attachment:${attachmentId}`, false);
    }
  };

  const handlePurgeAttachment = async (attachment) => {
    const treeId = String(attachment.treeId);
    const attachmentId = String(attachment.id);
    const confirmed = window.confirm(`Purge attachment "${attachment.fileName}" from tree "${attachment.treeDisplayName}" permanently? This cannot be undone.`);

    if (!confirmed) {
      return;
    }

    setPending(`purge-attachment:${attachmentId}`, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/admin/deleted", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "purge-attachment", treeId, attachmentId }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Attachment could not be purged");
      }

      setStatusMessage(`Attachment ${attachmentId} in tree ${treeId} was purged.`);
      await loadDeletedItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Attachment could not be purged"));
    } finally {
      setPending(`purge-attachment:${attachmentId}`, false);
    }
  };

  const handleIndexingAction = async (target, mode) => {
    const pendingKey = `indexing:${mode}:${target}`;

    setPending(pendingKey, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/admin/indexing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ target, mode }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(formatIndexingErrorMessage(data, "Indexing request failed"));
      }

      setStatusMessage(formatIndexingResultMessage(data));
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Indexing request failed"));
    } finally {
      setPending(pendingKey, false);
    }
  };

  if (!user) {
    return (
      <main className={`${styles.pageShell} appPageShell`}>
        <section className={`appTopLevelPanel ${styles.heroCard}`}>
          <p className="appEyebrow">Admin</p>
          <h1 className="appPageTitle">Admin operations</h1>
          <p className="appPageDescription">Sign in with a user that has the mdsadmin role to manage search indexing and deletions.</p>
        </section>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className={`${styles.pageShell} appPageShell`}>
        <section className={`appTopLevelPanel ${styles.heroCard}`}>
          <p className="appEyebrow">Admin</p>
          <h1 className="appPageTitle">Admin operations</h1>
          <p className="appPageDescription">This page requires the mdsadmin role.</p>
        </section>
      </main>
    );
  }

  return (
    <main className={`${styles.pageShell} appPageShell`}>
      <section className={`appTopLevelPanel ${styles.heroCard}`}>
        <div className={styles.heroHeader}>
          <div className="appHeroCopy">
            <p className="appEyebrow">Admin</p>
            <h1 className="appPageTitle">Admin operations</h1>
            <div className={styles.heroDescriptionStack}>
              <p className="appPageDescription">Review soft-deleted trees, nodes, and attachments, then undelete or purge them when retention is no longer needed.</p>
              <p className="appPageDescription">Start Azure AI Search indexing actions for node data and blob content, with incremental run or full reset-and-run options.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={loadDeletedItems}
            disabled={isLoading}
            className="appPrimaryFormButton"
          >
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        {statusMessage ? <p className={styles.statusMessage}>{statusMessage}</p> : null}
        {errorMessage ? <p className={styles.errorMessage}>{errorMessage}</p> : null}
      </section>

      <section className={styles.grid}>
        <div className={styles.column}>
          <article className={`appTopLevelPanel ${styles.panel}`}>
            <div className={`appPanelTopBar ${styles.panelToolbar}`}>
              <div className={styles.panelHeaderGroup}>
                <span className={styles.panelHeading}>Deleted Trees</span>
                <span className={styles.countLabel}>{deletedTrees.length}</span>
              </div>
              <button
                type="button"
                onClick={handlePurgeAllTrees}
                disabled={isLoading || deletedTrees.length === 0 || Boolean(pendingItems["bulk:trees"])}
                className="appCompactActionButton appCompactActionButtonDanger"
              >
                {pendingItems["bulk:trees"] ? "Purging..." : "Purge All"}
              </button>
            </div>
            <div className={styles.panelBody}>
              {isLoading ? (
                <div className={styles.emptyState}>Loading deleted trees...</div>
              ) : deletedTrees.length === 0 ? (
                <div className={styles.emptyState}>No deleted trees are waiting for undelete or purge.</div>
              ) : (
                <div className={styles.list}>
                  {deletedTrees.map((tree) => {
                    const pendingKey = `tree:${tree.id}`;
                    const undeletePendingKey = `undelete-tree:${tree.id}`;

                    return (
                      <article key={tree.id} className={styles.listItem}>
                        <div className={styles.itemMeta}>
                          <div className={styles.itemHeader}>
                            <span className={styles.badge}>Tree {tree.id}</span>
                            <span className={styles.badgeMuted}>{tree.isPrivate ? "Private" : "Public"}</span>
                          </div>
                          <h2 className={styles.itemTitle}>{tree.name}</h2>
                          <p className={styles.itemDetail}>Deleted at: {formatTimestamp(tree.deletedAt)}</p>
                          {tree.ownerDisplayName || tree.ownerUserDetails ? (
                            <p className={styles.itemDetail}>Owner: {tree.ownerDisplayName || tree.ownerUserDetails}</p>
                          ) : null}
                        </div>
                        <div className={styles.actionGroup}>
                          <button
                            type="button"
                            onClick={() => handleUndeleteTree(tree)}
                            disabled={Boolean(pendingItems[undeletePendingKey]) || Boolean(pendingItems[pendingKey])}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                          >
                            {pendingItems[undeletePendingKey] ? "Undeleting..." : "Undelete"}
                          </button>
                          <button
                            type="button"
                            onClick={() => handlePurgeTree(tree)}
                            disabled={Boolean(pendingItems[pendingKey]) || Boolean(pendingItems[undeletePendingKey])}
                            className="appCompactActionButton appCompactActionButtonDanger"
                          >
                            {pendingItems[pendingKey] ? "Purging..." : "Purge"}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </article>

          <article className={`appTopLevelPanel ${styles.panel}`}>
            <div className={`appPanelTopBar ${styles.panelToolbar}`}>
              <div className={styles.panelHeaderGroup}>
                <span className={styles.panelHeading}>Deleted Attachments</span>
                <span className={styles.countLabel}>{deletedAttachments.length}</span>
              </div>
            </div>
            <div className={styles.panelBody}>
              {isLoading ? (
                <div className={styles.emptyState}>Loading deleted attachments...</div>
              ) : deletedAttachments.length === 0 ? (
                <div className={styles.emptyState}>No individually deleted attachments are currently waiting for undelete or purge.</div>
              ) : (
                <div className={styles.list}>
                  {deletedAttachments.map((attachment) => {
                    const undeletePendingKey = `undelete-attachment:${attachment.id}`;
                    const purgePendingKey = `purge-attachment:${attachment.id}`;

                    return (
                      <article key={attachment.id} className={styles.listItem}>
                        <div className={styles.itemMeta}>
                          <div className={styles.itemHeader}>
                            <span className={styles.badge}>Tree {attachment.treeId}</span>
                            <span className={styles.badge}>Node {attachment.nodeId}</span>
                            <span className={styles.badgeMuted}>Attachment {attachment.id}</span>
                          </div>
                          <h2 className={styles.itemTitle}>{attachment.fileName}</h2>
                          <p className={styles.itemDetail}>Tree: {attachment.treeDisplayName}</p>
                          <p className={styles.itemDetail}>Node: {attachment.nodeTitle}</p>
                          <p className={styles.itemDetail}>{attachment.breadcrumb || "No breadcrumb available."}</p>
                          <p className={styles.itemDetail}>Deleted at: {formatTimestamp(attachment.deletedAt)}</p>
                        </div>
                        <div className={styles.actionGroup}>
                          <button
                            type="button"
                            onClick={() => handleUndeleteAttachment(attachment)}
                            disabled={Boolean(pendingItems[undeletePendingKey]) || Boolean(pendingItems[purgePendingKey])}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                          >
                            {pendingItems[undeletePendingKey] ? "Undeleting..." : "Undelete"}
                          </button>
                          <button
                            type="button"
                            onClick={() => handlePurgeAttachment(attachment)}
                            disabled={Boolean(pendingItems[purgePendingKey]) || Boolean(pendingItems[undeletePendingKey])}
                            className="appCompactActionButton appCompactActionButtonDanger"
                          >
                            {pendingItems[purgePendingKey] ? "Purging..." : "Purge"}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </article>
        </div>

        <div className={styles.column}>
        <article className={`appTopLevelPanel ${styles.panel}`}>
          <div className={`appPanelTopBar ${styles.panelToolbar}`}>
            <div className={styles.panelHeaderGroup}>
              <span className={styles.panelHeading}>Deleted Nodes</span>
              <span className={styles.countLabel}>{deletedNodes.length}</span>
            </div>
            <button
              type="button"
              onClick={handlePurgeAllNodes}
              disabled={isLoading || deletedNodes.length === 0 || Boolean(pendingItems["bulk:nodes"])}
              className="appCompactActionButton appCompactActionButtonDanger"
            >
              {pendingItems["bulk:nodes"] ? "Purging..." : "Purge All"}
            </button>
          </div>
          <div className={styles.panelBody}>
            {isLoading ? (
              <div className={styles.emptyState}>Loading deleted nodes...</div>
            ) : deletedNodes.length === 0 ? (
              <div className={styles.emptyState}>No deleted nodes are currently exposed by the search view.</div>
            ) : (
              <div className={styles.list}>
                {deletedNodes.map((node) => {
                  const pendingKey = `node:${node.id}`;
                  const undeletePendingKey = `undelete-node:${node.id}`;

                  return (
                    <article key={node.id} className={styles.listItem}>
                      <div className={styles.itemMeta}>
                        <div className={styles.itemHeader}>
                          <span className={styles.badge}>Tree {node.treeId}</span>
                          <span className={styles.badge}>Node {node.nodeId}</span>
                          {node.hasAttachments ? <span className={styles.badgeMuted}>{node.attachmentCount} attachment{node.attachmentCount === 1 ? "" : "s"}</span> : null}
                        </div>
                        <h2 className={styles.itemTitle}>{node.title}</h2>
                        <p className={styles.itemDetail}>Tree: {node.treeDisplayName}</p>
                        <p className={styles.itemDetail}>{node.breadcrumb || "No breadcrumb available."}</p>
                        <p className={styles.itemDetail}>Search-view delete marker timestamp: {formatTimestamp(node.updatedAt)}</p>
                        {!node.canUndelete ? <p className={styles.itemDetail}>Undelete is unavailable while the parent tree is still deleted.</p> : null}
                      </div>
                      <div className={styles.actionGroup}>
                        {node.canUndelete ? (
                          <button
                            type="button"
                            onClick={() => handleUndeleteNode(node)}
                            disabled={Boolean(pendingItems[undeletePendingKey]) || Boolean(pendingItems[pendingKey])}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                          >
                            {pendingItems[undeletePendingKey] ? "Undeleting..." : "Undelete"}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => handlePurgeNode(node)}
                          disabled={Boolean(pendingItems[pendingKey]) || Boolean(pendingItems[undeletePendingKey])}
                          className="appCompactActionButton appCompactActionButtonDanger"
                        >
                          {pendingItems[pendingKey] ? "Purging..." : "Purge"}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </article>
        </div>
      </section>

      <section className={styles.sectionStack}>
        <article className={`appTopLevelPanel ${styles.panel}`}>
          <div className={`appPanelTopBar ${styles.panelToolbar}`}>
            <div className={styles.panelHeaderGroup}>
              <span className={styles.panelHeading}>Search indexing</span>
            </div>
          </div>
          <div className={styles.panelBody}>
            <p className={styles.sectionDescription}>Incremental starts the selected indexer run. Full resets the selected indexer and then starts it. All targets both the SQL node-data indexer and the blob-content indexer.</p>
            <div className={styles.indexingTableWrapper}>
              <table className={styles.indexingTable}>
                <thead>
                  <tr>
                    <th scope="col" className={styles.indexingCornerCell}>scope</th>
                    {INDEXING_COLUMNS.map((column) => (
                      <th key={column.key} scope="col" className={styles.indexingColumnHeader}>{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {INDEXING_ROWS.map((row) => (
                    <tr key={row.key}>
                      <th scope="row" className={styles.indexingRowHeader}>{row.label}</th>
                      {INDEXING_COLUMNS.map((column) => {
                        const pendingKey = `indexing:${column.key}:${row.key}`;

                        return (
                          <td key={`${row.key}:${column.key}`} className={styles.indexingActionCell}>
                            <button
                              type="button"
                              onClick={() => handleIndexingAction(row.key, column.key)}
                              disabled={Boolean(pendingItems[pendingKey])}
                              className="appCompactActionButton appCompactActionButtonNeutral"
                              aria-label={`Start ${column.label} indexing for ${row.label}`}
                            >
                              {pendingItems[pendingKey] ? "Starting..." : "Start"}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </article>
      </section>
    </main>
  );
}