"use client";
import { Suspense } from "react";
import { useState, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tree } from "react-arborist";

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

    setTreeData(buildNestedTreeData(flatData));
    setExpandedState(extractExpandedState(flatData));
    setSelectedNodeId(getNextSelectedNodeId(flatData, selectedNodeId, targetSelectedNodeId));
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
          }
        } else {
          setAvailableTrees([]);
          setTreeData([]);
          setExpandedState({});
          setSelectedNodeId(null);
          setError(trees.error || "Unknown error, data is not array");
        }
      })
      .catch((err) => {
        console.error("Tree list error:", err);
        setAvailableTrees([]);
        setTreeData([]);
        setExpandedState({});
        setSelectedNodeId(null);
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
          setTreeData(buildNestedTreeData(flatData));
          setExpandedState(extractExpandedState(flatData));
          setSelectedNodeId(getNextSelectedNodeId(flatData, null, flatData[0]?.id ?? null));
          setError(null);
        } else {
          setTreeData([]);
          setExpandedState({});
          setSelectedNodeId(null);
          setError(flatData.error || "Unknown error, data is not array");
        }
      })
      .catch((err) => {
        console.error("Data error:", err);
        setTreeData([]);
        setExpandedState({});
        setSelectedNodeId(null);
        setError(err.message);
      });
  }, [treeIdParam]);

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

  if (error) {
    return <div style={{ color: "red" }}>Error: {error}</div>;
  }

  return (
    <div style={{ height: "100vh", width: "100%", padding: 16, boxSizing: "border-box" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          padding: "12px 16px",
          border: "1px solid #d4d4d8",
          borderRadius: 10,
          backgroundColor: "#fafafa",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#27272a" }}>Tree</span>
          <select
            value={treeIdParam ?? ""}
            onChange={(event) => {
              // Update the URL with the selected treeId, which will trigger the effect to fetch and populate the selected tree.
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
        <span style={{ color: "#52525b" }}>
          {selectedNode
            ? `Selected: ${selectedNode.name}`
            : "Select a node to enable actions."}
        </span>
      </div>
      <Tree
        ref={treeRef}
        key={treeIdParam ?? "tree-empty"}
        data={treeData}
        selection={selectedNodeId ?? undefined}
        initialOpenState={expandedState}
        openByDefault={false}
        width="100%"
        height={600}
        indent={24}
        rowHeight={36}
        overscanCount={1}
        paddingTop={30}
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
            <div style={style} ref={dragHandle}>
              {dataNodeHasChildren(node.data) && (
                <span
                  onClick={() => {
                    node.toggle();
                  }}
                  style={{ cursor: "pointer", marginRight: 4 }}
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
  );
}
