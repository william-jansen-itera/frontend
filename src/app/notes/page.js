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

  // Create a map of nodes by their id
  flatData.forEach(node => {
    idToNodeMap[node.id] = { ...node, children: [] };
  });

  // Build the tree structure
  flatData.forEach(node => {
    if (node.parent === null) {
      rootNodes.push(idToNodeMap[node.id]);
    } else {
      idToNodeMap[node.parent].children.push(idToNodeMap[node.id]);
    }
  });
  return rootNodes;
};

function flattenTreeData(nodes, parentId = null) {
    let flatData = [];

    nodes.forEach(node => {
        // Add the current node to the flat data
        const { children, ...rest } = node; // Exclude children for the flat structure
        flatData.push({ ...rest, parent: parentId });

        // Recursively flatten the children
        if (children && children.length > 0) {
            flatData = flatData.concat(flattenTreeData(children, node.id));
        }
    });

    return flatData;
}

function NotesPage() {
  const [treeData, setTreeData] = useState([]);
  const treeRef = useRef(); // Create a ref for the Tree instance
  const [error, setError] = useState(null);
  const searchParams = useSearchParams();
  const idParam = searchParams.get('id');

  useEffect(() => {
    if (!idParam) {
      setError('Invalid request, id parameter not found');
      setTreeData([]);
      return;
    }
    fetch(`/api/notes?id=${idParam}`)
      .then((res) => res.json())
      .then((flatData) => {
        if (Array.isArray(flatData)) {
          const nestedTreeData = buildNestedTreeData(flatData)
          //console.log("Nested tree data:", nestedTreeData);
          setTreeData(nestedTreeData);
          setError(null);
        } else {
          setTreeData([]);
          setError(flatData.error || "Unknown error, data is not array");
        }
      })
      .catch((err) => {
        console.error('Data error:', err);
        setTreeData([]);
        setError(err.message);
      });
  }, [idParam]);

  const handleMove = async ({ dragIds, parentId, index }) => {
    console.log("Move event:", { dragIds, parentId, index });

    // Access the Tree instance if needed
    // const tree = treeRef.current;
    // if (tree) {
    //   console.log("Tree instance:", tree);
    //   // Example: Access a specific node
    //   const node = tree.get(dragIds[0]);
    //   https://www.npmjs.com/package/react-arborist#tree-api-reference
    // }

    try {
      // Update the tree data in state
      // first detect existing parent and index of dragged nodes
      let existingParentId = 0, existingIndex = 0;
      const flatData = flattenTreeData(treeData).map(node => {
        if (dragIds.includes(node.id)) {
          existingParentId = node.parent;
          existingIndex = node.sort_order;
          return { ...node, parent: parentId };
        }
        return { ...node };
      });
      //abort if no changes
      if (existingParentId == parentId && existingIndex == index) {
        console.log("No changes in position, do nothing.");
      //implement changes
      } else {
        let abandonedSiblingIndexCounter = 0, siblingIndexCounter = 0;
        //change sort_order of all affected nodes
        flatData.forEach(node => {
          // update indexes within parent
          if (node.parent == parentId) { 
            if (dragIds.includes(node.id)) { 
              node.sort_order = index;
            } else {
              // node inserted (new parent)
              if (parentId != existingParentId) {
                if (siblingIndexCounter < index) {
                  node.sort_order = siblingIndexCounter;
                } else {
                  node.sort_order = siblingIndexCounter + 1;
                }
              // node moved up
              } else if(index < existingIndex) {          
                if (siblingIndexCounter < index || siblingIndexCounter > existingIndex) {
                  node.sort_order = siblingIndexCounter;
                } else {
                  node.sort_order = siblingIndexCounter + 1;
                }
              //node moved down
              } else if(index > existingIndex) {
                if (siblingIndexCounter < existingIndex || siblingIndexCounter > index) {
                  node.sort_order = siblingIndexCounter;
                } else {
                  node.sort_order = siblingIndexCounter -1
                }
              }
            }
            siblingIndexCounter++;
          }      
          // if parent was new also update indexes of abandoned siblings
          if (parentId != existingParentId) {          
            if (node.parent == existingParentId) {          
              node.sort_order = abandonedSiblingIndexCounter;
              abandonedSiblingIndexCounter++;
            }
          }
        });
        // send the updated tree data to the server
        console.log("Flat data to send to server:", flatData);
        fetch("/api/notes", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(flatData),
        })
        .then((res) => res.json())
        .then((flatData) => {
          console.log(" Updated data returned from server:", flatData);
          // rerender the tree with the response
          if (Array.isArray(flatData)) {
            setTreeData(buildNestedTreeData(flatData));
          }
        });
      }      
    } catch (err) {
      console.error("Failed to update tree:", err);
    }
  };

  if (error) {
    return <div style={{ color: "red" }}>Error: {error}</div>;
  }

  return (
    <div style={{ height: "100vh", width: "100%" }}>
      <Tree
        ref={treeRef} // Attach the ref to the Tree component
        data={treeData}
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
        // Allow drag on draggable nodes only
        disableDrag={(node) => !node.draggable}
        // Allow drop on droppable nodes only
        disableDrop={({ parentNode }) =>
          parentNode ? !parentNode.data.droppable : false
        }
      >
        {({ node, style, dragHandle }) => { 
        //console.log(node.isLeaf);
        return (
          <div style={style} ref={dragHandle}>
            {node.data.droppable && (
              <span 
                onClick={() => {
                  node.toggle(); // Call toggle
                }} 
                style={{ cursor: "pointer", marginRight: 4 }}
              >
                {/* {node.isLeaf ? "🍁" : "🗀"} */}
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
