"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import styles from "../page.module.css";
import { buildAuditLabel, formatTimestamp, getErrorMessage } from "../adminShared";

export default function AdminDeletionsPage() {
  const t = useTranslations("Pages.Admin.Deletions");
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
    Promise.resolve().then(() => {
      loadDeletedItems();
    });
  }, []);

  const handlePurgeTree = async (tree) => {
    const treeId = String(tree.id);
    const confirmed = window.confirm(t("ConfirmTree", { name: tree.name }));

    if (!confirmed) {
      return;
    }

    setPending(`tree:${treeId}`, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/admin/deleted", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "purge-tree", treeId }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Tree could not be purged");
      }

      setStatusMessage(t("TreePurged", { id: treeId }));
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

      setStatusMessage(t("TreeUndeleted", { id: treeId }));
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

    const confirmed = window.confirm(t("ConfirmTrees"));

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

      setStatusMessage(t("TreesPurged", { count: Number(data?.purgedTreeCount ?? 0) }));
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
    const confirmed = window.confirm(t("ConfirmNode", { name: node.title, tree: node.treeDisplayName }));

    if (!confirmed) {
      return;
    }

    setPending(`node:${node.id}`, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/admin/deleted", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "purge-node", treeId, nodeId }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Node could not be purged");
      }

      setStatusMessage(t("NodePurged", { id: nodeId, treeId }));
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

      setStatusMessage(t("NodeUndeleted", { id: nodeId, treeId }));
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

    const confirmed = window.confirm(t("ConfirmNodes"));

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

      setStatusMessage(t("NodesPurged", { count: Number(data?.purgedNodeCount ?? 0) }));
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

      setStatusMessage(t("AttachmentUndeleted", { id: attachmentId, treeId }));
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
    const confirmed = window.confirm(t("ConfirmAttachment", { name: attachment.fileName, tree: attachment.treeDisplayName }));

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

      setStatusMessage(t("AttachmentPurged", { id: attachmentId, treeId }));
      await loadDeletedItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Attachment could not be purged"));
    } finally {
      setPending(`purge-attachment:${attachmentId}`, false);
    }
  };

  const handlePurgeAllAttachments = async () => {
    if (deletedAttachments.length === 0) {
      return;
    }

    const confirmed = window.confirm(t("ConfirmAttachments"));

    if (!confirmed) {
      return;
    }

    setPending("bulk:attachments", true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/admin/deleted", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "purge-all-attachments" }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Deleted attachments could not be purged");
      }

      setStatusMessage(t("AttachmentsPurged", { count: Number(data?.purgedAttachmentCount ?? 0) }));
      await loadDeletedItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Deleted attachments could not be purged"));
    } finally {
      setPending("bulk:attachments", false);
    }
  };

  return (
    <>
      <section className={`appTopLevelPanel ${styles.heroCard}`}>
        <div className={styles.heroHeader}>
          <div className="appHeroCopy">
            <p className="appEyebrow">{t("Title")}</p>
            <h2 className="appPageTitle">{t("Heading")}</h2>
            <div className={styles.heroDescriptionStack}>
              <p className="appPageDescription">{t("Intro")}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={loadDeletedItems}
            disabled={isLoading}
            className="appPrimaryFormButton"
          >
            {t(isLoading ? "Refreshing" : "Refresh")}
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
                <span className={styles.panelHeading}>{t("Trees")}</span>
                <span className={styles.countLabel}>{deletedTrees.length}</span>
              </div>
              <button
                type="button"
                onClick={handlePurgeAllTrees}
                disabled={isLoading || deletedTrees.length === 0 || Boolean(pendingItems["bulk:trees"])}
                className="appCompactActionButton appCompactActionButtonDanger"
              >
                {t(pendingItems["bulk:trees"] ? "Purging" : "PurgeAll")}
              </button>
            </div>
            <div className={styles.panelBody}>
              {isLoading ? (
                <div className={styles.emptyState}>{t("LoadingTrees")}</div>
              ) : deletedTrees.length === 0 ? (
                <div className={styles.emptyState}>{t("EmptyTrees")}</div>
              ) : (
                <div className={styles.list}>
                  {deletedTrees.map((tree) => {
                    const pendingKey = `tree:${tree.id}`;
                    const undeletePendingKey = `undelete-tree:${tree.id}`;

                    return (
                      <article key={tree.id} className={styles.listItem}>
                        <div className={styles.itemMeta}>
                          <div className={styles.itemHeader}>
                            <span className={styles.badge}>{t("TreeId", { id: tree.id })}</span>
                            <span className={styles.badgeMuted}>{t(tree.isPrivate ? "Private" : "Public")}</span>
                          </div>
                          <h2 className={styles.itemTitle}>{tree.name}</h2>
                          <p className={styles.itemDetail}>{t("DeletedAt", { date: formatTimestamp(tree.deletedAt) })}</p>
                          {tree.ownerDisplayName || tree.ownerUserDetails ? (
                            <p className={styles.itemDetail}>{t("Owner", { name: tree.ownerDisplayName || tree.ownerUserDetails })}</p>
                          ) : null}
                        </div>
                        <div className={styles.actionGroup}>
                          <button
                            type="button"
                            onClick={() => handleUndeleteTree(tree)}
                            disabled={Boolean(pendingItems[undeletePendingKey]) || Boolean(pendingItems[pendingKey])}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                          >
                            {t(pendingItems[undeletePendingKey] ? "Undeleting" : "Undelete")}
                          </button>
                          <button
                            type="button"
                            onClick={() => handlePurgeTree(tree)}
                            disabled={Boolean(pendingItems[pendingKey]) || Boolean(pendingItems[undeletePendingKey])}
                            className="appCompactActionButton appCompactActionButtonDanger"
                          >
                            {t(pendingItems[pendingKey] ? "Purging" : "Purge")}
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
                <span className={styles.panelHeading}>{t("Attachments")}</span>
                <span className={styles.countLabel}>{deletedAttachments.length}</span>
              </div>
              <button
                type="button"
                onClick={handlePurgeAllAttachments}
                disabled={isLoading || deletedAttachments.length === 0 || Boolean(pendingItems["bulk:attachments"])}
                className="appCompactActionButton appCompactActionButtonDanger"
              >
                {t(pendingItems["bulk:attachments"] ? "Purging" : "PurgeAll")}
              </button>
            </div>
            <div className={styles.panelBody}>
              {isLoading ? (
                <div className={styles.emptyState}>{t("LoadingAttachments")}</div>
              ) : deletedAttachments.length === 0 ? (
                <div className={styles.emptyState}>{t("EmptyAttachments")}</div>
              ) : (
                <div className={styles.list}>
                  {deletedAttachments.map((attachment) => {
                    const undeletePendingKey = `undelete-attachment:${attachment.id}`;
                    const purgePendingKey = `purge-attachment:${attachment.id}`;

                    return (
                      <article key={attachment.id} className={styles.listItem}>
                        <div className={styles.itemMeta}>
                          <div className={styles.itemHeader}>
                            <span className={styles.badge}>{t("TreeId", { id: attachment.treeId })}</span>
                            <span className={styles.badge}>{t("NodeId", { id: attachment.nodeId })}</span>
                            <span className={styles.badgeMuted}>{t("AttachmentId", { id: attachment.id })}</span>
                          </div>
                          <h2 className={styles.itemTitle}>{attachment.fileName}</h2>
                          <p className={styles.itemDetail}>{t("TreeName", { name: attachment.treeDisplayName })}</p>
                          <p className={styles.itemDetail}>{t("NodeName", { name: attachment.nodeTitle })}</p>
                          <p className={styles.itemDetail}>{attachment.breadcrumb || t("NoBreadcrumb")}</p>
                          <p className={styles.itemDetail}>{t("DeletedAt", { date: formatTimestamp(attachment.deletedAt) })}</p>
                        </div>
                        <div className={styles.actionGroup}>
                          <button
                            type="button"
                            onClick={() => handleUndeleteAttachment(attachment)}
                            disabled={Boolean(pendingItems[undeletePendingKey]) || Boolean(pendingItems[purgePendingKey])}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                          >
                            {t(pendingItems[undeletePendingKey] ? "Undeleting" : "Undelete")}
                          </button>
                          <button
                            type="button"
                            onClick={() => handlePurgeAttachment(attachment)}
                            disabled={Boolean(pendingItems[purgePendingKey]) || Boolean(pendingItems[undeletePendingKey])}
                            className="appCompactActionButton appCompactActionButtonDanger"
                          >
                            {t(pendingItems[purgePendingKey] ? "Purging" : "Purge")}
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
                <span className={styles.panelHeading}>{t("Nodes")}</span>
                <span className={styles.countLabel}>{deletedNodes.length}</span>
              </div>
              <button
                type="button"
                onClick={handlePurgeAllNodes}
                disabled={isLoading || deletedNodes.length === 0 || Boolean(pendingItems["bulk:nodes"])}
                className="appCompactActionButton appCompactActionButtonDanger"
              >
                {t(pendingItems["bulk:nodes"] ? "Purging" : "PurgeAll")}
              </button>
            </div>
            <div className={styles.panelBody}>
              {isLoading ? (
                <div className={styles.emptyState}>{t("LoadingNodes")}</div>
              ) : deletedNodes.length === 0 ? (
                <div className={styles.emptyState}>{t("EmptyNodes")}</div>
              ) : (
                <div className={styles.list}>
                  {deletedNodes.map((node) => {
                    const pendingKey = `node:${node.id}`;
                    const undeletePendingKey = `undelete-node:${node.id}`;

                    return (
                      <article key={node.id} className={styles.listItem}>
                        <div className={styles.itemMeta}>
                          <div className={styles.itemHeader}>
                            <span className={styles.badge}>{t("TreeId", { id: node.treeId })}</span>
                            <span className={styles.badge}>{t("NodeId", { id: node.nodeId })}</span>
                            {node.hasAttachments ? <span className={styles.badgeMuted}>{t("AttachmentCount", { count: node.attachmentCount })}</span> : null}
                          </div>
                          <h2 className={styles.itemTitle}>{node.title}</h2>
                          <p className={styles.itemDetail}>{t("TreeName", { name: node.treeDisplayName })}</p>
                          <p className={styles.itemDetail}>{node.breadcrumb || t("NoBreadcrumb")}</p>
                          {buildAuditLabel(node.updatedByUserDetails, node.updatedAt) ? (
                            <p className={styles.itemDetail}>{buildAuditLabel(node.updatedByUserDetails, node.updatedAt)}</p>
                          ) : null}
                          {!node.canUndelete ? <p className={styles.itemDetail}>{t("Unavailable")}</p> : null}
                        </div>
                        <div className={styles.actionGroup}>
                          {node.canUndelete ? (
                            <button
                              type="button"
                              onClick={() => handleUndeleteNode(node)}
                              disabled={Boolean(pendingItems[undeletePendingKey]) || Boolean(pendingItems[pendingKey])}
                              className="appCompactActionButton appCompactActionButtonNeutral"
                            >
                              {t(pendingItems[undeletePendingKey] ? "Undeleting" : "Undelete")}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => handlePurgeNode(node)}
                            disabled={Boolean(pendingItems[pendingKey]) || Boolean(pendingItems[undeletePendingKey])}
                            className="appCompactActionButton appCompactActionButtonDanger"
                          >
                            {t(pendingItems[pendingKey] ? "Purging" : "Purge")}
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
    </>
  );
}