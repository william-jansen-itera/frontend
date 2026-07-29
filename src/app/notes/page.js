"use client";
import { Suspense } from "react";
import { useState, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tree } from "react-arborist";
import styles from "./page.module.css";

export default function NotesPageWrapper() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <NotesPage />
    </Suspense>
  );
}

function buildNestedTreeData(flatData) {
  const idToNodeMap = {};
  const rootNodes = [];

  flatData.forEach((node) => {
    idToNodeMap[node.id] = { ...node, children: [] };
  });

  flatData.forEach((node) => {
    if (node.parent === null) {
      rootNodes.push(idToNodeMap[node.id]);
    } else {
      idToNodeMap[node.parent].children.push(idToNodeMap[node.id]);
    }
  });

  return rootNodes;
}

function flattenTreeData(nodes, parentId = null) {
  let flatData = [];

  nodes.forEach((node) => {
    const { children, ...rest } = node;
    flatData.push({ ...rest, parent: parentId });

    if (children && children.length > 0) {
      flatData = flatData.concat(flattenTreeData(children, node.id));
    }
  });

  return flatData;
}

// Collect the IDs of all expandable nodes (on change to tree or node toggle state)
function collectExpandableNodeIds(nodes) {
  return nodes.flatMap((node) => {
    const childIds = node.children ? collectExpandableNodeIds(node.children) : [];
    return node.isLeafNode ? childIds : [String(node.id), ...childIds];
  });
}

// Extract the expanded state (on tree mount and node move)
function extractExpandedState(flatData) {
  return flatData.reduce((nextExpandedState, node) => {
    if (!node.isLeafNode && node.isExpanded) {
      nextExpandedState[String(node.id)] = true;
    }

    return nextExpandedState;
  }, {});
}

function findNodeById(nodes, targetId) {
  for (const node of nodes) {
    if (String(node.id) === String(targetId)) {
      return node;
    }

    if (node.children) {
      const childMatch = findNodeById(node.children, targetId);
      if (childMatch) {
        return childMatch;
      }
    }
  }

  return null;
}

function getNextSelectedNodeId(flatData, currentSelectedNodeId, targetSelectedNodeId = null) {
  const nextSelectedNodeId = targetSelectedNodeId ?? currentSelectedNodeId;
  if (!nextSelectedNodeId) {
    return null;
  }

  const matchingNode = flatData.find((node) => String(node.id) === String(nextSelectedNodeId));
  return matchingNode ? String(nextSelectedNodeId) : null;
}

function getTreeSelectionHref(pathname, searchParamsString, nextTreeId) {
  const nextSearchParams = new URLSearchParams(searchParamsString);

  if (nextTreeId) {
    nextSearchParams.set("treeId", String(nextTreeId));
  } else {
    nextSearchParams.delete("treeId");
  }

  const nextQueryString = nextSearchParams.toString();
  return nextQueryString ? `${pathname}?${nextQueryString}` : pathname;
}

function dataNodeHasChildren(dataNode) {
  return Array.isArray(dataNode?.children) && dataNode.children.length > 0;
}

function buildNodeEditorState(nodeDetails = null) {
  return {
    name: nodeDetails?.name ?? "",
    description: nodeDetails?.description ?? "",
    notes: nodeDetails?.notes ?? "",
  };
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
  const [availablePageHeight, setAvailablePageHeight] = useState(0);
  const [treeContentHeight, setTreeContentHeight] = useState(0);
  const pageContainerRef = useRef(null);
  const treeContentRef = useRef(null);
  const treeRef = useRef();
  const isApplyingExpandedStateRef = useRef(false);
  const [error, setError] = useState(null);
  const selectedNode = selectedNodeId ? findNodeById(treeData, selectedNodeId) : null;
  const canAddChild = Boolean(selectedNode && !selectedNode.isLeafNode);
  const canDelete = Boolean(selectedNode && selectedNode.parent !== null);
  const panelHeight = availablePageHeight || 600;
  const treeHeight = treeContentHeight || 240;

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
      let existingParentId = 0;
      let existingIndex = 0;
      const flatData = flattenTreeData(treeData).map((node) => {
        if (dragIds.includes(node.id)) {
          existingParentId = node.parent;
          existingIndex = node.sort_order;
          return { ...node, parent: parentId };
        }

        return { ...node };
      });

      if (existingParentId == parentId && existingIndex == index) {
        console.log("No changes in position, do nothing.");
      } else {
        let abandonedSiblingIndexCounter = 0;
        let siblingIndexCounter = 0;

        flatData.forEach((node) => {
          if (node.parent == parentId) {
            if (dragIds.includes(node.id)) {
              node.sort_order = index;
            } else if (parentId != existingParentId) {
              node.sort_order = siblingIndexCounter < index
                ? siblingIndexCounter
                : siblingIndexCounter + 1;
            } else if (index < existingIndex) {
              node.sort_order =
                siblingIndexCounter < index || siblingIndexCounter > existingIndex
                  ? siblingIndexCounter
                  : siblingIndexCounter + 1;
            } else if (index > existingIndex) {
              node.sort_order =
                siblingIndexCounter < existingIndex || siblingIndexCounter > index
                  ? siblingIndexCounter
                  : siblingIndexCounter - 1;
            }

            siblingIndexCounter++;
          }

          if (parentId != existingParentId && node.parent == existingParentId) {
            node.sort_order = abandonedSiblingIndexCounter;
            abandonedSiblingIndexCounter++;
          }
        });

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

  const handleNodeEditorChange = (field, value) => {
    setNodeEditorState((currentState) => ({
      ...currentState,
      [field]: value,
    }));
  };

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
