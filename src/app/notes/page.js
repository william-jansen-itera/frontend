"use client";
import { useState, useEffect } from "react";
import { DndProvider } from "react-dnd";
import { Tree, getBackendOptions, MultiBackend } from "@minoru/react-dnd-treeview";

export default function NotesPage() {
  //manage in-memory state and rendering with 
  const [treeData, setTreeData] = useState([]);

  // This effect only runs once, because of the empty dependency array []
  useEffect(() => {
    fetch("/api/notes")
      .then((res) => res.json())
      .then((data) => setTreeData(data))
      .catch((err) => {
        // Optionally handle error
        console.error('Data error:', err);
        setTreeData([]);
      });
  }, []);

  return (
    <DndProvider backend={MultiBackend} options={getBackendOptions()}>
      <Tree
        tree={treeData}
        rootId={0}
        onDrop={(newTree) => setTreeData(newTree)}
        render={(node, { depth, isOpen, onToggle }) => (
          <div style={{ marginLeft: depth * 10 }}>
            {node.droppable && (
              <span onClick={onToggle} style={{ cursor: "pointer", marginRight: 4 }}>
                {isOpen ? "[-]" : "[+]"}
              </span>
            )}
            {node.text}
          </div>
        )}
      />
    </DndProvider>
  );
}
