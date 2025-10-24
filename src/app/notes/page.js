"use client";
import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { DndProvider } from "react-dnd";
import { Tree, getBackendOptions, MultiBackend } from "@minoru/react-dnd-treeview";

export default function NotesPage() {
  const [treeData, setTreeData] = useState([]);
  const [error, setError] = useState(null);
  const searchParams = useSearchParams();
  const idParam = searchParams.get('id');
  // console.log("idParam: ", idParam);

  useEffect(() => {
    if (!idParam) {
      setError('Invalid request, id parameter not found');
      setTreeData([]);
      return;
    }
    fetch(`/api/notes?id=${idParam}`)
      .then((res) => res.json())
      .then((data) => {
        console.log("Is api data array:", Array.isArray(data), data);
        if (Array.isArray(data)) {
          setTreeData(data);
          setError(null);
        } else {
          setTreeData([]);
          setError(data.error || "Unknown error, data is not array");
        }
      })
      .catch((err) => {
        console.error('Data error:', err);
        setTreeData([]);
        setError(err.message);
      });
  }, [idParam]);

  if (error) {
    return <div style={{ color: "red" }}>Error: {error}</div>;
  }

  return (
    <DndProvider backend={MultiBackend} options={getBackendOptions()}>
      <Tree
        tree={treeData}
        rootId={null}
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
