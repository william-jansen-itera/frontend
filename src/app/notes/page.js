"use client";
import { Suspense } from "react";
import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
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

function NotesPage() {
  const searchParams = useSearchParams();
  const idParam = searchParams.get("id");
  const [treeData, setTreeData] = useState([]);
  const [expandedState, setExpandedState] = useState({});
  const treeRef = useRef();
  const isApplyingExpandedStateRef = useRef(false);
  const [error, setError] = useState(null);
  const invalidRequestError = !idParam ? "Invalid request, id parameter not found" : null;

  // Fetch the tree data when the component mounts or when idParam changes
  useEffect(() => {
    if (!idParam) {
      return;
    }

    fetch(`/api/notes?id=${idParam}`)
      .then((res) => res.json())
      .then((flatData) => {
        if (Array.isArray(flatData)) {
          setTreeData(buildNestedTreeData(flatData));
          setExpandedState(extractExpandedState(flatData));
          setError(null);
        } else {
          setTreeData([]);
          setExpandedState({});
          setError(flatData.error || "Unknown error, data is not array");
        }
      })
      .catch((err) => {
        console.error("Data error:", err);
        setTreeData([]);
        setExpandedState({});
        setError(err.message);
      });
  }, [idParam]);

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
          body: JSON.stringify(flatData),
        })
          .then((res) => res.json())
          .then((updatedFlatData) => {
            console.log("Updated data returned from server:", updatedFlatData);
            if (Array.isArray(updatedFlatData)) {
              setTreeData(buildNestedTreeData(updatedFlatData));
              setExpandedState(extractExpandedState(updatedFlatData));
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
        body: JSON.stringify({ id, isExpanded }),
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

  if (invalidRequestError || error) {
    return <div style={{ color: "red" }}>Error: {invalidRequestError || error}</div>;
  }

  return (
    <div style={{ height: "100vh", width: "100%" }}>
      <Tree
        ref={treeRef}
        key={idParam}
        data={treeData}
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
        disableDrag={(node) => !node.draggable}
        disableDrop={({ parentNode }) =>
          parentNode ? parentNode.data.isLeafNode : false
        }
      >
        {({ node, style, dragHandle }) => {
          return (
            <div style={style} ref={dragHandle}>
              {!node.data.isLeafNode && (
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
