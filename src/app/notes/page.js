"use client";
import { Suspense } from "react";
import { useState, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tree } from "react-arborist";
import styles from "./page.module.css";
import { NotesEditor } from "./NotesEditor";
import { usePanelLayout } from "./usePanelLayout";
import {
  buildMovedFlatData,
  buildNestedTreeData,
  buildNodeEditorState,
  collectExpandableNodeIds,
  dataNodeHasLeafDescendants,
  dataNodeHasChildren,
  extractExpandedState,
  findNodeById,
  getNextSelectedNodeId,
  getTreeSelectionHref,
} from "./treeUtils";

const ATTACHMENT_ACCEPT = ".csv,.doc,.docx,.gif,.html,.jpeg,.jpg,.json,.md,.pdf,.png,.ppt,.pptx,.txt,.webp,.xls,.xlsx";

function formatAttachmentSize(byteSize) {
  const size = Number(byteSize);

  if (!Number.isFinite(size) || size < 1024) {
    return `${size || 0} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function NotesPageWrapper() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <NotesPage />
    </Suspense>
  );
}

// Main NotesPage component runs whenever state changes, including treeIdParam, treeData, expandedState, and selectedNodeId
function NotesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const treeIdParam = searchParams.get("treeId");
  const [availableTrees, setAvailableTrees] = useState([]);
  const [treeData, setTreeData] = useState([]);
  const [expandedState, setExpandedState] = useState({});
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [nodeEditorState, setNodeEditorState] = useState(() => buildNodeEditorState());
  const [nodeDetailsError, setNodeDetailsError] = useState(null);
  const [isSavingNodeDetails, setIsSavingNodeDetails] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState(null);
  const { pageContainerRef, treeContentRef, panelHeight, treeHeight } = usePanelLayout();
  const treeRef = useRef();
  const attachmentInputRef = useRef(null);
  const isApplyingExpandedStateRef = useRef(false);
  const [error, setError] = useState(null);
  const selectedNode = selectedNodeId ? findNodeById(treeData, selectedNodeId) : null;
  const canAddRoot = Boolean(treeIdParam);
  const canAddChild = Boolean(selectedNode && !selectedNode.isLeafNode);
  const canDelete = Boolean(selectedNode);
  const canEditLeafDetails = Boolean(selectedNode?.isLeafNode);
  const isNodeDetailsBusy = isSavingNodeDetails || isUploadingAttachments || deletingAttachmentId !== null;

  const applyTreeResponse = (flatData, targetSelectedNodeId = null) => {
    if (!Array.isArray(flatData)) {
      return;
    }

    const nextSelectedNodeId = getNextSelectedNodeId(flatData, selectedNodeId, targetSelectedNodeId);
    const nextSelectedNode = nextSelectedNodeId
      ? flatData.find((node) => String(node.id) === String(nextSelectedNodeId))
      : null;

    setTreeData(buildNestedTreeData(flatData));
    setExpandedState(extractExpandedState(flatData));
    setSelectedNodeId(nextSelectedNodeId);
    setNodeEditorState(buildNodeEditorState(nextSelectedNode ? { name: nextSelectedNode.name } : null));
    setNodeDetailsError(null);
    setPendingFiles([]);

    if (attachmentInputRef.current) {
      attachmentInputRef.current.value = "";
    }
  };
  // Fetch the list of available trees on mount
  useEffect(() => {
    fetch("/api/notes")
      .then((res) => res.json())
      .then((trees) => {
        if (Array.isArray(trees)) {
          setAvailableTrees(trees);
          setError(null);

          if (trees.length === 0) {
            setTreeData([]);
            setExpandedState({});
            setSelectedNodeId(null);
            setNodeEditorState(buildNodeEditorState());
          }
        } else {
          setAvailableTrees([]);
          setTreeData([]);
          setExpandedState({});
          setSelectedNodeId(null);
          setNodeEditorState(buildNodeEditorState());
          setError(trees.error || "Unknown error, data is not array");
        }
      })
      .catch((err) => {
        console.error("Tree list error:", err);
        setAvailableTrees([]);
        setTreeData([]);
        setExpandedState({});
        setSelectedNodeId(null);
        setNodeEditorState(buildNodeEditorState());
        setError(err.message);
      });
  }, []);

  // Ensure the selected treeId is valid and update the URL if not to the first available treeId
  useEffect(() => {
    if (availableTrees.length === 0) {
      return;
    }

    const requestedTreeExists = treeIdParam
      ? availableTrees.some((tree) => String(tree.id) === String(treeIdParam))
      : false;
    const nextTreeId = requestedTreeExists ? String(treeIdParam) : String(availableTrees[0].id);

    if (String(treeIdParam) !== nextTreeId) {
      router.replace(getTreeSelectionHref(pathname, searchParams.toString(), nextTreeId), { scroll: false });
    }
  }, [availableTrees, treeIdParam, pathname, router, searchParams]);

  // Fetch the tree data when the selected treeId changes
  useEffect(() => {
    if (!treeIdParam) {
      return;
    }

    fetch(`/api/notes?treeId=${encodeURIComponent(treeIdParam)}`)
      .then((res) => res.json())
      .then((flatData) => {
        if (Array.isArray(flatData)) {
          const nextSelectedNodeId = getNextSelectedNodeId(flatData, null, flatData[0]?.id ?? null);
          const nextSelectedNode = nextSelectedNodeId
            ? flatData.find((node) => String(node.id) === String(nextSelectedNodeId))
            : null;

          setTreeData(buildNestedTreeData(flatData));
          setExpandedState(extractExpandedState(flatData));
          setSelectedNodeId(nextSelectedNodeId);
          setNodeEditorState(buildNodeEditorState(nextSelectedNode ? { name: nextSelectedNode.name } : null));
          setNodeDetailsError(null);
          setError(null);
        } else {
          setTreeData([]);
          setExpandedState({});
          setSelectedNodeId(null);
          setNodeEditorState(buildNodeEditorState());
          setError(flatData.error || "Unknown error, data is not array");
        }
      })
      .catch((err) => {
        console.error("Data error:", err);
        setTreeData([]);
        setExpandedState({});
        setSelectedNodeId(null);
        setNodeEditorState(buildNodeEditorState());
        setError(err.message);
      });
  }, [treeIdParam]);

  // Fetch the details of the selected node when selectedNodeId changes
  useEffect(() => {
    if (!treeIdParam || !selectedNodeId) {
      return;
    }

    if (!selectedNode?.isLeafNode) {
      return;
    }

    let isCancelled = false;

    fetch(`/api/notes?treeId=${encodeURIComponent(treeIdParam)}&include=details&id=${encodeURIComponent(selectedNodeId)}`)
      .then((res) => res.json().then((result) => ({ ok: res.ok, result })))
      .then(({ ok, result }) => {
        if (isCancelled) {
          return;
        }

        if (!ok) {
          throw new Error(result.error || "Failed to load node details");
        }

        setNodeEditorState(buildNodeEditorState(result));
        setNodeDetailsError(null);
      })
      .catch((err) => {
        if (isCancelled) {
          return;
        }

        console.error("Node details error:", err);
        setNodeDetailsError(err.message);
      })
      .finally(() => undefined);

    return () => {
      isCancelled = true;
    };
  }, [treeIdParam, selectedNodeId, selectedNode]);

  // Apply the expanded state to the tree when treeData or expandedState changes
  useEffect(() => {
    const tree = treeRef.current;

    if (!tree || treeData.length === 0) {
      return;
    }

    isApplyingExpandedStateRef.current = true;

    try {
      // Apply the expanded state (present in the expandedState = expanded)
      collectExpandableNodeIds(treeData).forEach((nodeId) => {
        if (expandedState[nodeId]) {
          if (!tree.isOpen(nodeId)) {
            tree.open(nodeId);
          }
        } else if (tree.isOpen(nodeId)) {
          tree.close(nodeId);
        }
      });
    } finally {
      isApplyingExpandedStateRef.current = false;
    }
  }, [treeData, expandedState]);

  const handleMove = async ({ dragIds, parentId, index }) => {
    console.log("Move event:", { dragIds, parentId, index });

    try {
      const { didPositionChange, flatData } = buildMovedFlatData(treeData, { dragIds, parentId, index });

      if (!didPositionChange) {
        console.log("No changes in position, do nothing.");
      } else {
        console.log("Flat data to send to server:", flatData);
        fetch("/api/notes", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ treeId: treeIdParam, nodes: flatData }),
        })
          .then((res) => res.json())
          .then((updatedFlatData) => {
            console.log("Updated data returned from server:", updatedFlatData);
            if (Array.isArray(updatedFlatData)) {
              applyTreeResponse(updatedFlatData);
            }
          });
      }
    } catch (err) {
      console.error("Failed to update tree:", err);
    }
  };

  const handleToggle = async (id) => {
    if (isApplyingExpandedStateRef.current) {
      return;
    }

    const tree = treeRef.current;
    const isExpanded = tree ? tree.isOpen(id) : false;
    const previousIsExpanded = Boolean(expandedState[id]);

    if (isExpanded === previousIsExpanded) {
      return;
    }

    setExpandedState((currentExpandedState) => {
      // if expanded, add to expanded state
      if (isExpanded) {
        return { ...currentExpandedState, [id]: true };
      }
      // if collapsed, remove from expanded state
      const nextExpandedState = { ...currentExpandedState };
      delete nextExpandedState[id];
      return nextExpandedState;
    });

    try {
      // Persist the open state change to the server
      const response = await fetch("/api/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, treeId: treeIdParam, isExpanded }),
      });

      if (!response.ok) {
        throw new Error("Failed to persist tree open state");
      }
    } catch (err) {
      console.error("Failed to persist tree open state:", err);
      setExpandedState((currentExpandedState) => {
        // revert the state back to previous expanded state
        if (previousIsExpanded) {
          return { ...currentExpandedState, [id]: true };
        }
        // revert the state back to previous collapsed state
        const nextExpandedState = { ...currentExpandedState };
        delete nextExpandedState[id];
        return nextExpandedState;
      });
    }
  };

  const handleAddRoot = async () => {
    if (!canAddRoot) {
      return;
    }

    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentId: null,
          treeId: treeIdParam,
          name: "New root node",
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Failed to add root node");
      }

      applyTreeResponse(result.flatData, result.createdNodeId);
    } catch (err) {
      console.error("Failed to add root node:", err);
    }
  };

  const handleAddChild = async () => {
    if (!canAddChild) {
      return;
    }

    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentId: selectedNode.id,
          treeId: treeIdParam,
          name: "New node",
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Failed to add tree node");
      }

      applyTreeResponse(result.flatData, result.createdNodeId);
    } catch (err) {
      console.error("Failed to add tree node:", err);
    }
  };

  const handleDelete = async () => {
    if (!canDelete) {
      return;
    }

    try {
      const response = await fetch(`/api/notes?id=${selectedNode.id}&treeId=${treeIdParam}`, {
        method: "DELETE",
      });
      const flatData = await response.json();
      if (!response.ok) {
        throw new Error(flatData.error || "Failed to delete tree node");
      }

      applyTreeResponse(flatData, selectedNode.parent);
    } catch (err) {
      console.error("Failed to delete tree node:", err);
    }
  };

  // Overwrites just the one field edited in current state, while keeping the other fields intact
  const handleNodeEditorChange = (field, value) => {
    setNodeEditorState((currentState) => ({
      ...currentState,
      [field]: value,
    }));
  };

  const handleAttachmentSelectionChange = (event) => {
    setPendingFiles(Array.from(event.target.files ?? []));
  };

  const handleUploadAttachments = async () => {
    if (!treeIdParam || !selectedNodeId || pendingFiles.length === 0 || !canEditLeafDetails) {
      return;
    }

    try {
      setIsUploadingAttachments(true);
      setNodeDetailsError(null);

      const formData = new FormData();
      formData.set("treeId", treeIdParam);
      formData.set("nodeId", selectedNodeId);
      pendingFiles.forEach((file) => {
        formData.append("files", file);
      });

      const response = await fetch("/api/notes", {
        method: "POST",
        body: formData,
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Failed to upload attachments");
      }

      setNodeEditorState(buildNodeEditorState(result));
      setPendingFiles([]);

      if (attachmentInputRef.current) {
        attachmentInputRef.current.value = "";
      }
    } catch (err) {
      console.error("Failed to upload attachments:", err);
      setNodeDetailsError(err.message);
    } finally {
      setIsUploadingAttachments(false);
    }
  };

  const handleDeleteAttachment = async (attachmentId) => {
    if (!treeIdParam || !attachmentId) {
      return;
    }

    try {
      setDeletingAttachmentId(String(attachmentId));
      setNodeDetailsError(null);

      const response = await fetch(
        `/api/notes?treeId=${encodeURIComponent(treeIdParam)}&attachmentId=${encodeURIComponent(attachmentId)}`,
        {
          method: "DELETE",
        },
      );

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Failed to delete attachment");
      }

      setNodeEditorState(buildNodeEditorState(result));
    } catch (err) {
      console.error("Failed to delete attachment:", err);
      setNodeDetailsError(err.message);
    } finally {
      setDeletingAttachmentId(null);
    }
  };

  // Save node editor state to the server 
  // and update state with the response, including treeData and nodeEditorState
  const handleSaveNodeDetails = async () => {
    if (!treeIdParam || !selectedNodeId || !nodeEditorState.name.trim()) {
      return;
    }

    try {
      setIsSavingNodeDetails(true);
      setNodeDetailsError(null);

      const response = await fetch("/api/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: selectedNodeId,
          treeId: treeIdParam,
          name: nodeEditorState.name,
          notes: nodeEditorState.notes,
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Failed to save node details");
      }

      applyTreeResponse(result.flatData, selectedNodeId);
      setNodeEditorState(buildNodeEditorState(result.details));
    } catch (err) {
      console.error("Failed to save node details:", err);
      setNodeDetailsError(err.message);
    } finally {
      setIsSavingNodeDetails(false);
    }
  };

  if (error) {
    return <div className={styles.errorMessage}>Error: {error}</div>;
  }

  return (
    <div
      ref={pageContainerRef}
      style={{
        width: "100%",
        height: panelHeight || undefined,
      }}
      className={styles.pageShell}
    >
      <div
        className={styles.panelGrid}
        style={{ height: "100%" }}
      >
        <div
          className={styles.panelShell}
          style={{ height: "100%" }}
        >
          <div className={styles.panelHeader}>
            <div className={styles.panelTitleWrap}>
              <h2 className={styles.panelTitle}>Tree Nodes</h2>
            </div>
            <div className={styles.panelToolbar}>
              <label className={styles.toolbarLabel}>
                <span className={styles.labelText}>Tree:</span>
                <select
                  value={treeIdParam ?? ""}
                  onChange={(event) => {
                    router.replace(
                      getTreeSelectionHref(pathname, searchParams.toString(), event.target.value || null),
                      { scroll: false },
                    );
                  }}
                  disabled={availableTrees.length === 0}
                >
                  {availableTrees.length === 0 ? (
                    <option value="">No trees available</option>
                  ) : (
                    availableTrees.map((tree) => (
                      <option key={tree.id} value={tree.id}>
                        {tree.name}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <button
                onClick={handleAddRoot}
                disabled={!canAddRoot}
                type="button"
                className={`${styles.toolbarButton} ${styles.toolbarButtonNeutral}`}
              >
                Add Root
              </button>
              <button
                onClick={handleAddChild}
                disabled={!canAddChild}
                type="button"
                className={`${styles.toolbarButton} ${styles.toolbarButtonNeutral}`}
              >
                Add Child
              </button>
              <button
                onClick={handleDelete}
                disabled={!canDelete}
                type="button"
                className={`${styles.toolbarButton} ${styles.toolbarButtonDanger}`}
              >
                Delete
              </button>
            </div>
          </div>
          <div ref={treeContentRef} className={styles.treeContent}>
            <Tree
              ref={treeRef}
              key={treeIdParam ?? "tree-empty"}
              data={treeData}
              selection={selectedNodeId ?? undefined}
              initialOpenState={expandedState}
              openByDefault={false}
              width="100%"
              height={treeHeight}
              indent={24}
              rowHeight={36}
              overscanCount={1}
              paddingTop={18}
              paddingBottom={10}
              padding={25}
              onMove={handleMove}
              onToggle={handleToggle}
              onSelect={(nodes) => {
                const nextSelectedNode = nodes.length === 1 ? nodes[0].data : null;

                setSelectedNodeId(nextSelectedNode ? String(nextSelectedNode.id) : null);
                setNodeEditorState(buildNodeEditorState(nextSelectedNode ? {
                  name: nextSelectedNode.name,
                  isLeafNode: nextSelectedNode.isLeafNode,
                } : null));
                setNodeDetailsError(null);
                setPendingFiles([]);

                if (attachmentInputRef.current) {
                  attachmentInputRef.current.value = "";
                }
              }}
              disableMultiSelection={true}
              disableDrag={(node) => !node.draggable}
              disableDrop={({ parentNode, dragNodes }) => {
                // Prevent dropping onto a leaf node
                if (parentNode && !parentNode.isRoot && parentNode.data.isLeafNode) {
                  return true;
                }

                const targetDepth = parentNode?.isRoot ? 0 : (parentNode?.data._depth ?? -1) + 1;
                return dragNodes.some((draggedRootNode) => {
                  const wouldChangeLevel = targetDepth !== draggedRootNode.data._depth;

                  if (!wouldChangeLevel) {
                    return false;
                  }
                  // if the dragged node is changing levels 
                  // and is either a leaf node or has leaf descendants, 
                  // block the move
                  return draggedRootNode.data.isLeafNode || dataNodeHasLeafDescendants(draggedRootNode.data);
                });
              }}
            >
              {({ node, style, dragHandle }) => {
                return (
                  <div
                    style={style}
                    ref={dragHandle}
                    className={[
                      styles.treeRow,
                      node.isSelected ? styles.treeRowSelected : "",
                      node.willReceiveDrop ? styles.treeRowDropTarget : "",
                    ].filter(Boolean).join(" ")}
                  >
                    {dataNodeHasChildren(node.data) && (
                      <span
                        onClick={() => {
                          node.toggle();
                        }}
                        className={styles.treeToggle}
                      >
                        {node.isOpen ? "[-]" : "[+]"}
                      </span>
                    )}
                    <span className={styles.treeRowLabel}>{node.data.name}</span>
                    {node.willReceiveDrop && !node.data.isLeafNode && (
                      <span className={styles.treeDropHint}>Drop into node</span>
                    )}
                  </div>
                );
              }}
            </Tree>
          </div>
        </div>
        <aside
          className={styles.panelShell}
          style={{ height: "100%" }}
        >
          <div className={styles.panelHeader}>
            <div className={styles.panelTitleWrap}>
              <h2 className={styles.panelTitle}>Node Details</h2>
            </div>
            <div className={`${styles.panelToolbar} ${styles.detailsToolbar}`}>
              <button
                onClick={handleSaveNodeDetails}
                disabled={!selectedNode || isSavingNodeDetails || !nodeEditorState.name.trim()}
                type="button"
                className={`${styles.toolbarButton} ${styles.toolbarButtonPrimary}`}
              >
                {isSavingNodeDetails ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
          <div className={styles.detailsContent}>
            {!selectedNode ? (
              <div className={styles.emptyState}>
                Select a node to edit its details.
              </div>
            ) : (
              <div className={styles.detailsForm}>
                <label className={styles.formField}>
                  <span className={styles.fieldLabel}>Name</span>
                  <input
                    type="text"
                    value={nodeEditorState.name}
                    onChange={(event) => handleNodeEditorChange("name", event.target.value)}
                    disabled={isNodeDetailsBusy}
                    className={styles.textInput}
                  />
                </label>
                {canEditLeafDetails ? (
                  <>
                    <label className={styles.formField}>
                      <span className={styles.fieldLabel}>Notes</span>
                      <NotesEditor
                        value={nodeEditorState.notes}
                        onChange={(nextValue) => handleNodeEditorChange("notes", nextValue)}
                        disabled={isNodeDetailsBusy}
                      />
                    </label>
                    <section className={styles.attachmentSection}>
                      <div className={styles.attachmentSectionHeader}>
                        <span className={styles.fieldLabel}>Attachments</span>
                        <span className={styles.attachmentHint}>Allowed up to 10 MB each.</span>
                      </div>
                      <div className={styles.attachmentPicker}>
                        <input
                          ref={attachmentInputRef}
                          type="file"
                          multiple
                          accept={ATTACHMENT_ACCEPT}
                          onChange={handleAttachmentSelectionChange}
                          disabled={isNodeDetailsBusy}
                        />
                        <button
                          onClick={handleUploadAttachments}
                          disabled={isNodeDetailsBusy || pendingFiles.length === 0}
                          type="button"
                        >
                          {isUploadingAttachments ? "Uploading..." : `Upload${pendingFiles.length ? ` (${pendingFiles.length})` : ""}`}
                        </button>
                      </div>
                      {nodeEditorState.attachments.length === 0 ? (
                        <div className={styles.emptyState}>No files uploaded for this node.</div>
                      ) : (
                        <div className={styles.attachmentList}>
                          {nodeEditorState.attachments.map((attachment) => (
                            <div key={attachment.id} className={styles.attachmentItem}>
                              <div className={styles.attachmentMeta}>
                                <strong>{attachment.fileName}</strong>
                                <span className={styles.attachmentHint}>
                                  {formatAttachmentSize(attachment.byteSize)}
                                  {attachment.contentType ? ` • ${attachment.contentType}` : ""}
                                </span>
                              </div>
                              <button
                                onClick={() => handleDeleteAttachment(attachment.id)}
                                disabled={isNodeDetailsBusy}
                                type="button"
                              >
                                {deletingAttachmentId === String(attachment.id) ? "Deleting..." : "Delete file"}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  </>
                ) : (
                  <div className={styles.detailConstraintMessage}>
                    Notes and attachments are only available for leaf nodes.
                  </div>
                )}
                {nodeDetailsError && (
                  <div className={styles.fieldError}>
                    {nodeDetailsError}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
