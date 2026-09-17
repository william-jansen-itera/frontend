"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/app/useAuth";
import styles from "../admin/page.module.css";

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

function buildAuditLabel(userDetails, timestamp, defaultLabel = null) {
  const parts = [];
  const normalizedUserDetails = String(userDetails ?? "").trim();
  const formattedTimestamp = timestamp ? formatTimestamp(timestamp) : null;

  if (normalizedUserDetails) {
    parts.push(normalizedUserDetails);
  }

  if (formattedTimestamp && formattedTimestamp !== "Unknown time") {
    parts.push(formattedTimestamp);
  }

  if (parts.length === 0) {
    return defaultLabel;
  }

  return parts.join(" • ");
}

function formatReviewStatusLabel(value) {
  const normalizedValue = String(value ?? "submitted").trim().toLowerCase();

  if (normalizedValue === "rejected") {
    return "Rejected";
  }

  return "Submitted";
}

function buildNotesHref(treeId, nodeId, isPrivate) {
  const searchParams = new URLSearchParams();
  searchParams.set("treeId", String(treeId));
  searchParams.set("nodeId", String(nodeId));

  if (isPrivate) {
    searchParams.set("visibility", "private");
  }

  return `/notes?${searchParams.toString()}`;
}

function buildTreesHref(isPrivate) {
  return isPrivate ? "/trees?visibility=private" : "/trees";
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

function formatRejectionComment(value) {
  const normalizedValue = String(value ?? "").trim();
  return normalizedValue || "No rejection comment recorded.";
}

function getTreeReviewScopeLabel(treeName) {
  return `tree "${treeName}" and everything in it, including all nodes, leaves, and attachments`;
}

function getNodeReviewScopeLabel(node) {
  if (node?.isLeafNode) {
    return `leaf node "${node.name}" only`;
  }

  return `branch node "${node?.name}", its descendant branches, and its leaf nodes`;
}

function getAttachmentReviewScopeLabel(fileName) {
  return `attachment "${fileName}" only`;
}

function getReviewActionPastTense(action) {
  if (action === "submit") {
    return "submitted";
  }

  if (action === "approve") {
    return "approved";
  }

  return "rejected";
}

export default function ReviewPage() {
  const { user } = useAuth();
  const [reviewStatus, setReviewStatus] = useState("submitted");
  const [trees, setTrees] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [pendingItems, setPendingItems] = useState({});
  const primaryBadgeClassName = reviewStatus === "submitted"
    ? `${styles.badge} ${styles.reviewBadgeSubmitted}`
    : styles.badge;

  const setPending = (key, isPending) => {
    setPendingItems((current) => ({
      ...current,
      [key]: isPending,
    }));
  };

  const refreshReviewItems = async () => {
    if (!user) {
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch(`/api/review?status=${encodeURIComponent(reviewStatus)}`, { cache: "no-store" });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Review items could not be loaded");
      }

      setTrees(Array.isArray(data?.trees) ? data.trees : []);
      setNodes(Array.isArray(data?.nodes) ? data.nodes : []);
      setAttachments(Array.isArray(data?.attachments) ? data.attachments : []);
      setErrorMessage("");
    } catch (error) {
      setTrees([]);
      setNodes([]);
      setAttachments([]);
      setErrorMessage(getErrorMessage(error, "Review items could not be loaded"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!user) {
      return undefined;
    }

    let isActive = true;

    void (async () => {
      try {
        const response = await fetch(`/api/review?status=${encodeURIComponent(reviewStatus)}`, { cache: "no-store" });
        const data = await response.json();

        if (!isActive) {
          return;
        }

        if (!response.ok) {
          throw new Error(data?.error || "Review items could not be loaded");
        }

        setTrees(Array.isArray(data?.trees) ? data.trees : []);
        setNodes(Array.isArray(data?.nodes) ? data.nodes : []);
        setAttachments(Array.isArray(data?.attachments) ? data.attachments : []);
        setErrorMessage("");
      } catch (error) {
        if (!isActive) {
          return;
        }

        setTrees([]);
        setNodes([]);
        setAttachments([]);
        setErrorMessage(getErrorMessage(error, "Review items could not be loaded"));
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      isActive = false;
    };
  }, [reviewStatus, user]);

  const handleTreeAction = async (tree, action) => {
    const pendingKey = `tree:${action}:${tree.id}`;
    const treeScopeLabel = getTreeReviewScopeLabel(tree.name);
    const rejectionComment = action === "reject"
      ? promptForRejectionComment(treeScopeLabel)
      : null;

    if (action === "reject" && rejectionComment === null) {
      return;
    }

    const label = action === "submit" ? "resubmit" : action;

    if (!window.confirm(`Are you sure you want to ${label} ${treeScopeLabel}?`)) {
      return;
    }

    setPending(pendingKey, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/trees", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          treeId: tree.id,
          rejectionComment,
          visibility: tree.isPrivate ? "private" : "public",
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Tree review action could not be completed");
      }

      setStatusMessage(`Tree ${tree.id} ${getReviewActionPastTense(action)}.`);
      await refreshReviewItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Tree review action could not be completed"));
    } finally {
      setPending(pendingKey, false);
    }
  };

  const handleNodeAction = async (node, action) => {
    const pendingKey = `node:${action}:${node.id}`;
    const nodeTargetLabel = getNodeReviewScopeLabel(node);
    const rejectionComment = action === "reject"
      ? promptForRejectionComment(nodeTargetLabel)
      : null;

    if (action === "reject" && rejectionComment === null) {
      return;
    }

    const label = action === "submit" ? "resubmit" : action;

    if (!window.confirm(`Are you sure you want to ${label} ${nodeTargetLabel}?`)) {
      return;
    }

    setPending(pendingKey, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/notes", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: `${action}-node-review`,
          treeId: node.treeId,
          id: node.id,
          rejectionComment,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Node review action could not be completed");
      }

      setStatusMessage(`Node ${node.id} ${getReviewActionPastTense(action)}.`);
      await refreshReviewItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Node review action could not be completed"));
    } finally {
      setPending(pendingKey, false);
    }
  };

  const handleAttachmentAction = async (attachment, action) => {
    const pendingKey = `attachment:${action}:${attachment.id}`;
    const attachmentTargetLabel = getAttachmentReviewScopeLabel(attachment.fileName);
    const rejectionComment = action === "reject"
      ? promptForRejectionComment(attachmentTargetLabel)
      : null;

    if (action === "reject" && rejectionComment === null) {
      return;
    }

    const label = action === "submit" ? "resubmit" : action;

    if (!window.confirm(`Are you sure you want to ${label} ${attachmentTargetLabel}?`)) {
      return;
    }

    setPending(pendingKey, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/notes", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: `${action}-attachment-review`,
          treeId: attachment.treeId,
          attachmentId: attachment.id,
          rejectionComment,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Attachment review action could not be completed");
      }

      setStatusMessage(`Attachment ${attachment.id} ${getReviewActionPastTense(action)}.`);
      await refreshReviewItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Attachment review action could not be completed"));
    } finally {
      setPending(pendingKey, false);
    }
  };

  const handleBulkAction = async (items, kind, action) => {
    if (items.length === 0) {
      return;
    }

    const itemLabel = kind === "tree"
      ? "tree"
      : kind === "node"
        ? "node"
        : "attachment";
    const itemCount = items.length;
    const normalizedAction = String(action ?? "").trim().toLowerCase();

    if (!["submit", "approve", "reject"].includes(normalizedAction)) {
      return;
    }

    const actionVerb = normalizedAction === "submit"
      ? "Submit"
      : normalizedAction === "approve"
        ? "Approve"
        : "Reject";
    const actionPastTense = normalizedAction === "submit"
      ? "Submitted"
      : normalizedAction === "approve"
        ? "Approved"
        : "Rejected";
    const actionProgressLabel = normalizedAction === "submit"
      ? "Submitting..."
      : normalizedAction === "approve"
        ? "Approving..."
        : "Rejecting...";
    const statusLabel = reviewStatus === "rejected" ? "rejected" : "submitted";
    const rejectionComment = normalizedAction === "reject"
      ? promptForRejectionComment(`${itemCount} ${statusLabel} ${itemLabel}${itemCount === 1 ? "" : "s"}`)
      : null;

    if (normalizedAction === "reject" && rejectionComment === null) {
      return;
    }

    if (!window.confirm(`${actionVerb} all ${itemCount} ${statusLabel} ${itemLabel}${itemCount === 1 ? "" : "s"}?`)) {
      return;
    }

    const pendingKey = `bulk:${kind}:${normalizedAction}`;

    setPending(pendingKey, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      for (const item of items) {
        if (kind === "tree") {
          const response = await fetch("/api/trees", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action: normalizedAction,
              treeId: item.id,
              rejectionComment,
              visibility: item.isPrivate ? "private" : "public",
            }),
          });
          const data = await response.json();

          if (!response.ok) {
            throw new Error(data?.error || `Tree ${item.id} could not be ${getReviewActionPastTense(normalizedAction)}`);
          }
        } else if (kind === "node") {
          const response = await fetch("/api/notes", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action: `${normalizedAction}-node-review`,
              treeId: item.treeId,
              id: item.id,
              rejectionComment,
            }),
          });
          const data = await response.json();

          if (!response.ok) {
            throw new Error(data?.error || `Node ${item.id} could not be ${getReviewActionPastTense(normalizedAction)}`);
          }
        } else {
          const response = await fetch("/api/notes", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action: `${normalizedAction}-attachment-review`,
              treeId: item.treeId,
              attachmentId: item.id,
              rejectionComment,
            }),
          });
          const data = await response.json();

          if (!response.ok) {
            throw new Error(data?.error || `Attachment ${item.id} could not be ${getReviewActionPastTense(normalizedAction)}`);
          }
        }
      }

      setStatusMessage(`${actionPastTense} ${itemCount} ${statusLabel} ${itemLabel}${itemCount === 1 ? "" : "s"}.`);
      await refreshReviewItems();
    } catch (error) {
      setErrorMessage(getErrorMessage(error, `${statusLabel.charAt(0).toUpperCase()}${statusLabel.slice(1)} ${itemLabel}${itemCount === 1 ? "" : "s"} could not be ${getReviewActionPastTense(normalizedAction)}`));
    } finally {
      setPending(pendingKey, false);
    }
  };

  const renderBulkActions = (items, kind) => {
    if (reviewStatus === "rejected") {
      return null;
    }

    const approveKey = `bulk:${kind}:approve`;
    const rejectKey = `bulk:${kind}:reject`;

    return (
      <div className={styles.actionGroup}>
        <button
          type="button"
          onClick={() => handleBulkAction(items, kind, "approve")}
          disabled={isLoading || items.length === 0 || Boolean(pendingItems[approveKey]) || Boolean(pendingItems[rejectKey])}
          className="appCompactActionButton appCompactActionButtonPrimary"
        >
          {pendingItems[approveKey] ? "Approving..." : "Approve All"}
        </button>
        <button
          type="button"
          onClick={() => handleBulkAction(items, kind, "reject")}
          disabled={isLoading || items.length === 0 || Boolean(pendingItems[rejectKey]) || Boolean(pendingItems[approveKey])}
          className="appCompactActionButton appCompactActionButtonDanger"
        >
          {pendingItems[rejectKey] ? "Rejecting..." : "Reject All"}
        </button>
      </div>
    );
  };

  const renderActions = (item, kind) => {
    if (reviewStatus === "rejected") {
      return null;
    }

    const approveKey = `${kind}:approve:${item.id}`;
    const rejectKey = `${kind}:reject:${item.id}`;

    return (
      <>
        <button
          type="button"
          onClick={() => {
            if (kind === "tree") {
              handleTreeAction(item, "approve");
            } else if (kind === "node") {
              handleNodeAction(item, "approve");
            } else {
              handleAttachmentAction(item, "approve");
            }
          }}
          disabled={Boolean(pendingItems[approveKey]) || Boolean(pendingItems[rejectKey])}
          className="appCompactActionButton appCompactActionButtonPrimary"
        >
          {pendingItems[approveKey] ? "Approving..." : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (kind === "tree") {
              handleTreeAction(item, "reject");
            } else if (kind === "node") {
              handleNodeAction(item, "reject");
            } else {
              handleAttachmentAction(item, "reject");
            }
          }}
          disabled={Boolean(pendingItems[rejectKey]) || Boolean(pendingItems[approveKey])}
          className="appCompactActionButton appCompactActionButtonDanger"
        >
          {pendingItems[rejectKey] ? "Rejecting..." : "Reject"}
        </button>
      </>
    );
  };

  if (!user) {
    return (
      <main className={`${styles.pageShell} appPageShell`}>
        <section className={`appTopLevelPanel ${styles.heroCard}`}>
          <p className="appEyebrow">Review</p>
          <p className="appPageDescription">Sign in to review submitted or rejected trees, nodes, and attachments from approval-enabled trees.</p>
        </section>
      </main>
    );
  }

  return (
    <main className={`${styles.pageShell} appPageShell`}>
      <section className={`appTopLevelPanel ${styles.heroCard}`}>
        <div className={styles.heroHeader}>
          <div className="appHeroCopy">
            <p className="appEyebrow">Review</p>
            <div className={styles.heroDescriptionStack}>
              <p className="appPageDescription">Review items from approval-enabled trees only. Use this page for submitted approvals and rejected resubmissions.</p>
            </div>
          </div>
          <div className={styles.heroControls}>
            <label className={styles.fieldStack}>
              <span className="appFieldLabel">View</span>
              <select
                value={reviewStatus}
                onChange={(event) => {
                  setIsLoading(true);
                  setReviewStatus(event.target.value);
                }}
                className="appSelectControl"
              >
                <option value="submitted">{formatReviewStatusLabel("submitted")}</option>
                <option value="rejected">{formatReviewStatusLabel("rejected")}</option>
              </select>
            </label>
            <button
              type="button"
              onClick={refreshReviewItems}
              disabled={isLoading}
              className="appPrimaryFormButton"
            >
              {isLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>
        {statusMessage ? <p className={styles.statusMessage}>{statusMessage}</p> : null}
        {errorMessage ? <p className={styles.errorMessage}>{errorMessage}</p> : null}
      </section>

      <section className={styles.grid}>
        <div className={styles.column}>
          <article className={`appTopLevelPanel ${styles.panel}`}>
            <div className={`appPanelTopBar ${styles.panelToolbar}`}>
              <div className={styles.panelHeaderGroup}>
                <span className={styles.panelHeading}>Trees</span>
                <span className={styles.countLabel}>{trees.length}</span>
              </div>
              {renderBulkActions(trees, "tree")}
            </div>
            <div className={styles.panelBody}>
              {isLoading ? (
                <div className={styles.emptyState}>Loading trees...</div>
              ) : trees.length === 0 ? (
                <div className={styles.emptyState}>No trees are currently in the {reviewStatus} state.</div>
              ) : (
                <div className={styles.list}>
                  {trees.map((tree) => (
                    <article key={tree.id} className={styles.listItem}>
                      <div className={styles.itemMeta}>
                        <div className={styles.itemHeader}>
                          <span className={primaryBadgeClassName}><span className={styles.badgeTextNudge}>Tree {tree.id}</span></span>
                          <span className={styles.badgeMuted}><span className={styles.badgeTextNudge}>{tree.isPrivate ? "Private" : "Public"}</span></span>
                        </div>
                        <h2 className={styles.itemTitle}>{tree.name}</h2>
                        <p className={styles.itemDetail}>{buildAuditLabel(tree.submittedByUserDetails, tree.submittedAt, "No submitter recorded")}</p>
                        {tree.reviewedAt || tree.reviewedByUserDetails ? (
                          <p className={styles.itemDetail}>{buildAuditLabel(tree.reviewedByUserDetails, tree.reviewedAt, null)}</p>
                        ) : null}
                        {reviewStatus === "rejected" ? (
                          <p className={styles.itemDetail}>Rejection comment: {formatRejectionComment(tree.rejectionComment)}</p>
                        ) : null}
                      </div>
                      <div className={styles.actionGroup}>
                        <Link href={buildTreesHref(tree.isPrivate)} className="appCompactActionButton appCompactActionButtonNeutral">Open</Link>
                        {renderActions(tree, "tree")}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </article>

          <article className={`appTopLevelPanel ${styles.panel}`}>
            <div className={`appPanelTopBar ${styles.panelToolbar}`}>
              <div className={styles.panelHeaderGroup}>
                <span className={styles.panelHeading}>Attachments</span>
                <span className={styles.countLabel}>{attachments.length}</span>
              </div>
              {renderBulkActions(attachments, "attachment")}
            </div>
            <div className={styles.panelBody}>
              {isLoading ? (
                <div className={styles.emptyState}>Loading attachments...</div>
              ) : attachments.length === 0 ? (
                <div className={styles.emptyState}>No attachments are currently in the {reviewStatus} state.</div>
              ) : (
                <div className={styles.list}>
                  {attachments.map((attachment) => (
                    <article key={attachment.id} className={styles.listItem}>
                      <div className={styles.itemMeta}>
                        <div className={styles.itemHeader}>
                          <span className={primaryBadgeClassName}><span className={styles.badgeTextNudge}>Tree {attachment.treeId}</span></span>
                          <span className={primaryBadgeClassName}><span className={styles.badgeTextNudge}>Node {attachment.nodeId}</span></span>
                          <span className={styles.badgeMuted}><span className={styles.badgeTextNudge}>Attachment {attachment.id}</span></span>
                        </div>
                        <h2 className={styles.itemTitle}>{attachment.fileName}</h2>
                        <p className={styles.itemDetail}>Tree: {attachment.treeName}</p>
                        <p className={styles.itemDetail}>{attachment.nodeBreadcrumb || "No breadcrumb available."}</p>
                        <p className={styles.itemDetail}>{buildAuditLabel(attachment.submittedByUserDetails, attachment.submittedAt, "No submitter recorded")}</p>
                        {attachment.reviewedAt || attachment.reviewedByUserDetails ? (
                          <p className={styles.itemDetail}>{buildAuditLabel(attachment.reviewedByUserDetails, attachment.reviewedAt, null)}</p>
                        ) : null}
                        {reviewStatus === "rejected" ? (
                          <p className={styles.itemDetail}>Rejection comment: {formatRejectionComment(attachment.rejectionComment)}</p>
                        ) : null}
                      </div>
                      <div className={styles.actionGroup}>
                        <Link href={buildNotesHref(attachment.treeId, attachment.nodeId, attachment.isPrivate)} className="appCompactActionButton appCompactActionButtonNeutral">Open</Link>
                        {renderActions(attachment, "attachment")}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </article>
        </div>

        <div className={styles.column}>
          <article className={`appTopLevelPanel ${styles.panel}`}>
            <div className={`appPanelTopBar ${styles.panelToolbar}`}>
              <div className={styles.panelHeaderGroup}>
                <span className={styles.panelHeading}>Nodes</span>
                <span className={styles.countLabel}>{nodes.length}</span>
              </div>
              {renderBulkActions(nodes, "node")}
            </div>
            <div className={styles.panelBody}>
              {isLoading ? (
                <div className={styles.emptyState}>Loading nodes...</div>
              ) : nodes.length === 0 ? (
                <div className={styles.emptyState}>No nodes are currently in the {reviewStatus} state.</div>
              ) : (
                <div className={styles.list}>
                  {nodes.map((node) => (
                    <article key={node.id} className={styles.listItem}>
                      <div className={styles.itemMeta}>
                        <div className={styles.itemHeader}>
                          <span className={primaryBadgeClassName}><span className={styles.badgeTextNudge}>Tree {node.treeId}</span></span>
                          <span className={primaryBadgeClassName}><span className={styles.badgeTextNudge}>Node {node.id}</span></span>
                          <span className={styles.badgeMuted}><span className={styles.badgeTextNudge}>{node.isLeafNode ? "Leaf" : "Branch"}</span></span>
                        </div>
                        <h2 className={styles.itemTitle}>{node.name}</h2>
                        <p className={styles.itemDetail}>Tree: {node.treeName}</p>
                        <p className={styles.itemDetail}>{node.breadcrumb || "No breadcrumb available."}</p>
                        <p className={styles.itemDetail}>{buildAuditLabel(node.submittedByUserDetails, node.submittedAt, "No submitter recorded")}</p>
                        {node.reviewedAt || node.reviewedByUserDetails ? (
                          <p className={styles.itemDetail}>{buildAuditLabel(node.reviewedByUserDetails, node.reviewedAt, null)}</p>
                        ) : null}
                        {reviewStatus === "rejected" ? (
                          <p className={styles.itemDetail}>Rejection comment: {formatRejectionComment(node.rejectionComment)}</p>
                        ) : null}
                      </div>
                      <div className={styles.actionGroup}>
                        <Link href={buildNotesHref(node.treeId, node.id, node.isPrivate)} className="appCompactActionButton appCompactActionButtonNeutral">Open</Link>
                        {renderActions(node, "node")}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </article>
        </div>
      </section>
    </main>
  );
}