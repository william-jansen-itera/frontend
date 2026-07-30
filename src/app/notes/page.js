"use client";
import { Suspense } from "react";
import { useState, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tree } from "react-arborist";
import styles from "./page.module.css";
import { usePanelLayout } from "./usePanelLayout";
import {
  buildMovedFlatData,
  buildNestedTreeData,
  buildNodeEditorState,
  collectExpandableNodeIds,
  dataNodeHasChildren,
  extractExpandedState,
  findNodeById,
  getNextSelectedNodeId,
  getTreeSelectionHref,
} from "./treeUtils";

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
  const { pageContainerRef, treeContentRef, panelHeight, treeHeight } = usePanelLayout();
  const treeRef = useRef();
  const isApplyingExpandedStateRef = useRef(false);
  const [error, setError] = useState(null);
  const selectedNode = selectedNodeId ? findNodeById(treeData, selectedNodeId) : null;
  const canAddChild = Boolean(selectedNode && !selectedNode.isLeafNode);
  const canDelete = Boolean(selectedNode && selectedNode.parent !== null);

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
  }, [treeIdParam, selectedNodeId]);

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

  const handleAdd = async () => {
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

      applyTreeResponse(result.flatData);
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
          description: nodeEditorState.description,
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
                <span className={styles.labelText}>Tree</span>
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
              <button onClick={handleAdd} disabled={!canAddChild} type="button">
                Add
              </button>
              <button onClick={handleDelete} disabled={!canDelete} type="button">
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
                setSelectedNodeId(nodes.length === 1 ? String(nodes[0].id) : null);
              }}
              disableMultiSelection={true}
              disableDrag={(node) => !node.draggable}
              disableDrop={({ parentNode }) =>
                parentNode ? parentNode.data.isLeafNode : false
              }
            >
              {({ node, style, dragHandle }) => {
                return (
                  <div style={style} ref={dragHandle} className={styles.treeRow}>
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
                    {node.data.name}
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
              <span className={styles.selectionStatus}>
                {selectedNode
                  ? `Selected: ${selectedNode.name}`
                  : "Select a node to edit its details."}
              </span>
              <button
                onClick={handleSaveNodeDetails}
                disabled={!selectedNode || isSavingNodeDetails || !nodeEditorState.name.trim()}
                type="button"
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
                    disabled={isSavingNodeDetails}
                    className={styles.textInput}
                  />
                </label>
                <label className={styles.formField}>
                  <span className={styles.fieldLabel}>Description</span>
                  <input
                    type="text"
                    value={nodeEditorState.description}
                    onChange={(event) => handleNodeEditorChange("description", event.target.value)}
                    disabled={isSavingNodeDetails}
                    className={styles.textInput}
                  />
                </label>
                <label className={styles.formField}>
                  <span className={styles.fieldLabel}>Notes</span>
                  <textarea
                    value={nodeEditorState.notes}
                    onChange={(event) => handleNodeEditorChange("notes", event.target.value)}
                    disabled={isSavingNodeDetails}
                    rows={12}
                    className={styles.textArea}
                  />
                </label>
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
