"use client";
import { useState } from "react";
import { DndProvider } from "react-dnd";
import { Tree, getBackendOptions, MultiBackend } from "@minoru/react-dnd-treeview";

const initialData = [
  { id: 1, parent: 0, droppable: true, text: "Projects" },
  { id: 2, parent: 1, droppable: true, text: "Frontend" },
  { id: 3, parent: 2, droppable: false, text: "index.js" },
  { id: 4, parent: 2, droppable: false, text: "App.js" },
  { id: 5, parent: 1, droppable: true, text: "Backend" },
  { id: 6, parent: 5, droppable: false, text: "api.js" },
  { id: 7, parent: 5, droppable: false, text: "db.js" },
  { id: 8, parent: 1, droppable: true, text: "Docs" },
  { id: 9, parent: 8, droppable: false, text: "README.md" },
  { id: 10, parent: 8, droppable: false, text: "CONTRIBUTING.md" },
  { id: 11, parent: 0, droppable: true, text: "Personal" },
  { id: 12, parent: 11, droppable: false, text: "todo.txt" },
  { id: 13, parent: 11, droppable: false, text: "notes.txt" }
];

export default function NotesPage() {
  const [treeData, setTreeData] = useState(initialData);

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
