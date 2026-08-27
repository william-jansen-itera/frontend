"use client";
import { Suspense } from "react";
import Image from "next/image";
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
  expandPathToNode,
  extractExpandedState,
  findNodeById,
  getAncestorExpandableNodeIds,
  getNextSelectedNodeId,
  getTreeSelectionHref,
} from "./treeUtils";

const ATTACHMENT_ACCEPT = ".csv,.doc,.docx,.gif,.html,.jpeg,.jpg,.json,.md,.pdf,.png,.ppt,.pptx,.txt,.webp,.xls,.xlsx";
const IMAGE_FILE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
const TREE_ROW_HEIGHT = 30;
const TREE_PADDING_TOP = 18;
const TREE_PADDING_BOTTOM = 10;
const TREE_HEIGHT_BUFFER = TREE_ROW_HEIGHT;

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

function getAttachmentPreviewType(attachment) {
  const fileName = String(attachment?.fileName || "").trim().toLowerCase();
  const contentType = String(attachment?.contentType || "").trim().toLowerCase();
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1) : "";

  if (contentType.startsWith("image/") || IMAGE_FILE_EXTENSIONS.has(extension)) {
    return "image";
  }

  return null;
}

function getNodeAttachmentContentUrl(attachment) {
  if (!attachment?.blobName) {
    return null;
  }

  return `/api/attachments/content?blobName=${encodeURIComponent(attachment.blobName)}`;
}

function countVisibleNodes(nodes, expandedState) {
  return nodes.reduce((total, node) => {
    const childCount = Array.isArray(node.children) && expandedState?.[String(node.id)]
      ? countVisibleNodes(node.children, expandedState)
      : 0;

    return total + 1 + childCount;
  }, 0);
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
  const nodeIdParam = searchParams.get("nodeId");
  const visibilityParam = searchParams.get("visibility") ?? "public";
  const [availableTrees, setAvailableTrees] = useState([]);
  const [loadedVisibility, setLoadedVisibility] = useState(null);
  const [treeData, setTreeData] = useState([]);
  const [expandedState, setExpandedState] = useState({});
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [nodeEditorState, setNodeEditorState] = useState(() => buildNodeEditorState());
  const [savedNodeEditorState, setSavedNodeEditorState] = useState(() => buildNodeEditorState());
  const [nodeDetailsError, setNodeDetailsError] = useState(null);
  const [isSavingNodeDetails, setIsSavingNodeDetails] = useState(false);
  const [isGeneratingChildren, setIsGeneratingChildren] = useState(false);
  const [isGeneratingNotes, setIsGeneratingNotes] = useState(false);
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState(null);
  const { pageContainerRef, treeContentRef, isStackedLayout, panelHeight, treeHeight } = usePanelLayout();
  const treeRef = useRef();
  const attachmentInputRef = useRef(null);
  const isApplyingExpandedStateRef = useRef(false);
  const [error, setError] = useState(null);
  const selectedNode = selectedNodeId ? findNodeById(treeData, selectedNodeId) : null;
  const canAddRoot = Boolean(treeIdParam);
  const canAddChild = Boolean(selectedNode && !selectedNode.isLeafNode);
  const canGenerateChildren = Boolean(selectedNode && !selectedNode.isLeafNode);
  const canDelete = Boolean(selectedNode);
  const canEditLeafDetails = Boolean(selectedNode?.isLeafNode);
  const canGenerateNotes = Boolean(selectedNode?.isLeafNode);
  const isNodeDetailsBusy = isSavingNodeDetails || isGeneratingNotes || isUploadingAttachments || deletingAttachmentId !== null;
  const isLoadingTrees = loadedVisibility !== visibilityParam;
  const resolvedTreeIdValue = treeIdParam ?? "";

  const visibilityQueryParam = visibilityParam === "public"
    ? ""
    : `&visibility=${encodeURIComponent(visibilityParam)}`;

  const navigateToSelectionHref = (nextHref, { replace = false } = {}) => {
    if (replace) {
      window.location.replace(nextHref);
      return;
    }

    window.location.assign(nextHref);
  };

  const applyTreeResponse = (flatData, targetSelectedNodeId = null) => {
    if (!Array.isArray(flatData)) {
      return;
    }

    const nextSelectedNodeId = getNextSelectedNodeId(flatData, selectedNodeId, targetSelectedNodeId);
    const nextSelectedNode = nextSelectedNodeId
      ? flatData.find((node) => String(node.id) === String(nextSelectedNodeId))
      : null;
    const nextExpandedState = expandPathToNode(
      flatData,
      extractExpandedState(flatData),
      nextSelectedNodeId,
    );

    setTreeData(buildNestedTreeData(flatData));
    setExpandedState(nextExpandedState);
    setSelectedNodeId(nextSelectedNodeId);
    const nextEditorState = buildNodeEditorState(nextSelectedNode ? { name: nextSelectedNode.name } : null);
    setNodeEditorState(nextEditorState);
    setSavedNodeEditorState(nextEditorState);
    setNodeDetailsError(null);
    setIsEditingNotes(false);
    setPendingFiles([]);

    if (attachmentInputRef.current) {
      attachmentInputRef.current.value = "";
    }
  };

  const resetTreeSelectionState = () => {
    setTreeData([]);
    setExpandedState({});
    setSelectedNodeId(null);
    const nextEditorState = buildNodeEditorState();
    setNodeEditorState(nextEditorState);
    setSavedNodeEditorState(nextEditorState);
    setNodeDetailsError(null);
    setIsEditingNotes(false);
    setPendingFiles([]);

    if (attachmentInputRef.current) {
      attachmentInputRef.current.value = "";
    }
  };

  // Fetch the list of available trees on mount
  useEffect(() => {
    let isCancelled = false;

    fetch(`/api/notes?visibility=${encodeURIComponent(visibilityParam)}`)
      .then((res) => res.json())
      .then((trees) => {
        if (isCancelled) {
          return;
        }

        if (Array.isArray(trees)) {
          setAvailableTrees(trees);
          setError(null);

          if (trees.length === 0) {
            setTreeData([]);
            setExpandedState({});
            setSelectedNodeId(null);
            const nextEditorState = buildNodeEditorState();
            setNodeEditorState(nextEditorState);
            setSavedNodeEditorState(nextEditorState);
            setIsEditingNotes(false);
          }
        } else {
          setAvailableTrees([]);
          setTreeData([]);
          setExpandedState({});
          setSelectedNodeId(null);
          const nextEditorState = buildNodeEditorState();
          setNodeEditorState(nextEditorState);
          setSavedNodeEditorState(nextEditorState);
          setIsEditingNotes(false);
          setError(trees.error || "Unknown error, data is not array");
        }

        setLoadedVisibility(visibilityParam);
      })
      .catch((err) => {
        if (isCancelled) {
          return;
        }

        console.error("Tree list error:", err);
        setAvailableTrees([]);
        setTreeData([]);
        setExpandedState({});
        setSelectedNodeId(null);
        const nextEditorState = buildNodeEditorState();
        setNodeEditorState(nextEditorState);
        setSavedNodeEditorState(nextEditorState);
        setIsEditingNotes(false);
        setError(err.message);
        setLoadedVisibility(visibilityParam);
      });

    return () => {
      isCancelled = true;
    };
  }, [visibilityParam]);

  // Ensure the selected treeId is valid and update the URL if not to the first available treeId
  useEffect(() => {
    if (isLoadingTrees) {
      return;
    }

    if (availableTrees.length === 0) {
      if (treeIdParam) {
        navigateToSelectionHref(getTreeSelectionHref(pathname, searchParams.toString(), null, visibilityParam), { replace: true });
      }

      return;
    }

    const requestedTreeExists = treeIdParam
      ? availableTrees.some((tree) => String(tree.id) === String(treeIdParam))
      : false;
    const nextTreeId = requestedTreeExists ? String(treeIdParam) : String(availableTrees[0].id);

    if (String(treeIdParam) !== nextTreeId) {
      navigateToSelectionHref(getTreeSelectionHref(pathname, searchParams.toString(), nextTreeId, visibilityParam), { replace: true });
    }
  }, [availableTrees, isLoadingTrees, treeIdParam, pathname, searchParams, visibilityParam]);

  // Fetch the tree data when the selected treeId changes
  useEffect(() => {
    if (!treeIdParam || isLoadingTrees) {
      return;
    }

    const requestedTreeExists = availableTrees.some((tree) => String(tree.id) === String(treeIdParam));
    if (!requestedTreeExists) {
      return;
    }

    fetch(`/api/notes?treeId=${encodeURIComponent(treeIdParam)}&visibility=${encodeURIComponent(visibilityParam)}`)
      .then((res) => res.json())
      .then((flatData) => {
        if (Array.isArray(flatData)) {
          const persistedExpandedState = extractExpandedState(flatData);
          const nextSelectedNodeId = getNextSelectedNodeId(
            flatData,
            null,
            nodeIdParam ? String(nodeIdParam) : null,
          );
          const nextSelectedNode = nextSelectedNodeId
            ? flatData.find((node) => String(node.id) === String(nextSelectedNodeId))
            : null;
          const nextExpandedState = expandPathToNode(
            flatData,
            persistedExpandedState,
            nextSelectedNodeId,
          );

          setTreeData(buildNestedTreeData(flatData));
          setExpandedState(nextExpandedState);
          setSelectedNodeId(nextSelectedNodeId);
          const nextEditorState = buildNodeEditorState(nextSelectedNode ? { name: nextSelectedNode.name } : null);
          setNodeEditorState(nextEditorState);
          setSavedNodeEditorState(nextEditorState);
          setNodeDetailsError(null);
          setIsEditingNotes(false);
          setError(null);

          const missingExpandedAncestorIds = nextSelectedNodeId
            ? getAncestorExpandableNodeIds(flatData, nextSelectedNodeId).filter((nodeId) => !persistedExpandedState[String(nodeId)])
            : [];

          if (missingExpandedAncestorIds.length > 0) {
            fetch("/api/notes", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                treeId: treeIdParam,
                expandedNodeIds: missingExpandedAncestorIds,
              }),
            }).catch((persistError) => {
              console.error("Failed to persist expanded ancestor path:", persistError);
            });
          }
        } else {
          setTreeData([]);
          setExpandedState({});
          setSelectedNodeId(null);
          const nextEditorState = buildNodeEditorState();
          setNodeEditorState(nextEditorState);
          setSavedNodeEditorState(nextEditorState);
          setIsEditingNotes(false);
          setError(flatData.error || "Unknown error, data is not array");
        }
      })
      .catch((err) => {
        console.error("Data error:", err);
        setTreeData([]);
        setExpandedState({});
        setSelectedNodeId(null);
        const nextEditorState = buildNodeEditorState();
        setNodeEditorState(nextEditorState);
        setSavedNodeEditorState(nextEditorState);
        setIsEditingNotes(false);
        setError(err.message);
      });
  }, [availableTrees, isLoadingTrees, treeIdParam, nodeIdParam, visibilityParam]);

  // Fetch the details of the selected node when selectedNodeId changes
  useEffect(() => {
    if (!treeIdParam || !selectedNodeId) {
      return;
    }

    if (!selectedNode?.isLeafNode) {
      return;
    }

    let isCancelled = false;

    fetch(`/api/notes?treeId=${encodeURIComponent(treeIdParam)}&include=details&id=${encodeURIComponent(selectedNodeId)}&visibility=${encodeURIComponent(visibilityParam)}`)
      .then((res) => res.json().then((result) => ({ ok: res.ok, result })))
      .then(({ ok, result }) => {
        if (isCancelled) {
          return;
        }

        if (!ok) {
          throw new Error(result.error || "Failed to load node details");
        }

        const nextEditorState = buildNodeEditorState(result);
        setNodeEditorState(nextEditorState);
        setSavedNodeEditorState(nextEditorState);
        setIsEditingNotes(false);
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
  }, [treeIdParam, selectedNodeId, selectedNode, visibilityParam]);

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

      if (selectedNodeId) {
        tree.select(selectedNodeId, { focus: false });
      }
    } finally {
      isApplyingExpandedStateRef.current = false;
    }
  }, [treeData, expandedState, selectedNodeId]);

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

    const confirmed = window.confirm(
      `Delete node "${selectedNode?.name || 'this node'}"? This action cannot be undone.`,
    );

    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(`/api/notes?id=${selectedNode.id}&treeId=${treeIdParam}${visibilityQueryParam}`, {
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

  const handleGenerateChildren = async () => {
    if (!treeIdParam || !selectedNode || !canGenerateChildren) {
      return;
    }

    const confirmed = window.confirm(
      `Generate new child nodes under "${selectedNode.name}"? Existing child nodes will be kept and any generated nodes will be added after them.`,
    );

    if (!confirmed) {
      return;
    }

    try {
      setIsGeneratingChildren(true);
      setNodeDetailsError(null);

      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate-children",
          treeId: treeIdParam,
          nodeId: selectedNode.id,
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Failed to generate child nodes");
      }

      applyTreeResponse(result.flatData, selectedNode.id);
    } catch (err) {
      console.error("Failed to generate child nodes:", err);
      setNodeDetailsError(err.message);
    } finally {
      setIsGeneratingChildren(false);
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

      const uploadedDetails = buildNodeEditorState(result);

      setNodeEditorState((currentState) => ({
        ...currentState,
        attachments: uploadedDetails.attachments,
      }));
      setSavedNodeEditorState((currentState) => ({
        ...currentState,
        attachments: uploadedDetails.attachments,
      }));
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

    const attachment = nodeEditorState.attachments.find((item) => String(item.id) === String(attachmentId));
    const confirmed = window.confirm(
      `Delete file "${attachment?.fileName || 'this file'}"? This action cannot be undone.`,
    );

    if (!confirmed) {
      return;
    }

    try {
      setDeletingAttachmentId(String(attachmentId));
      setNodeDetailsError(null);

      const response = await fetch(
        `/api/notes?treeId=${encodeURIComponent(treeIdParam)}&attachmentId=${encodeURIComponent(attachmentId)}&visibility=${encodeURIComponent(visibilityParam)}`,
        {
          method: "DELETE",
        },
      );

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Failed to delete attachment");
      }

      const refreshedDetails = buildNodeEditorState(result);

      setNodeEditorState((currentState) => ({
        ...currentState,
        attachments: refreshedDetails.attachments,
      }));
      setSavedNodeEditorState((currentState) => ({
        ...currentState,
        attachments: refreshedDetails.attachments,
      }));
    } catch (err) {
      console.error("Failed to delete attachment:", err);
      setNodeDetailsError(err.message);
    } finally {
      setDeletingAttachmentId(null);
    }
  };

  const handleGenerateNotes = async () => {
    if (!treeIdParam || !selectedNodeId || !canGenerateNotes || !isEditingNotes) {
      return;
    }

    const confirmed = window.confirm(
      `Generate draft notes for "${selectedNode?.name || 'this node'}"? The generated notes will be inserted into the editor and will not be saved until you press Save.`,
    );

    if (!confirmed) {
      return;
    }

    try {
      setIsGeneratingNotes(true);
      setNodeDetailsError(null);

      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate-notes",
          treeId: treeIdParam,
          nodeId: selectedNodeId,
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Failed to generate draft notes");
      }

      setNodeEditorState((currentState) => ({
        ...currentState,
        notes: typeof result.notes === "string" ? result.notes : currentState.notes,
      }));
    } catch (err) {
      console.error("Failed to generate draft notes:", err);
      setNodeDetailsError(err.message);
    } finally {
      setIsGeneratingNotes(false);
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
      const nextEditorState = buildNodeEditorState(result.details);
      setNodeEditorState(nextEditorState);
      setSavedNodeEditorState(nextEditorState);
      setIsEditingNotes(false);
    } catch (err) {
      console.error("Failed to save node details:", err);
      setNodeDetailsError(err.message);
    } finally {
      setIsSavingNodeDetails(false);
    }
  };

  const handleStartEditingNotes = () => {
    if (!canEditLeafDetails || isNodeDetailsBusy) {
      return;
    }

    setIsEditingNotes(true);
  };

  const handleCancelEditingNotes = () => {
    setNodeEditorState((currentState) => ({
      ...currentState,
      notes: savedNodeEditorState.notes,
    }));
    setNodeDetailsError(null);
    setIsEditingNotes(false);
  };

  if (error && !isLoadingTrees) {
    return <div className={styles.errorMessage}>Error: {error}</div>;
  }

  const visibleNodeCount = countVisibleNodes(treeData, expandedState);
  const stackedTreeHeight = Math.max((visibleNodeCount * TREE_ROW_HEIGHT) + TREE_PADDING_TOP + TREE_PADDING_BOTTOM + TREE_HEIGHT_BUFFER, 160);
  const resolvedTreeHeight = isStackedLayout ? stackedTreeHeight : treeHeight;
  const pageContainerStyle = isStackedLayout
    ? { width: "100%" }
    : {
      width: "100%",
      height: panelHeight || undefined,
    };
  const panelGridStyle = isStackedLayout ? undefined : { height: "100%" };
  const treePanelStyle = isStackedLayout ? undefined : { height: "100%" };
  const detailsPanelStyle = isStackedLayout ? undefined : { height: "100%" };

  return (
    <div
      ref={pageContainerRef}
      style={pageContainerStyle}
      className={`${styles.notesPageShell} appPageShell`}
    >
      <div
        className={styles.panelGrid}
        style={panelGridStyle}
      >
        <div
          className={`appPanelShell ${styles.panelShell}`}
          style={treePanelStyle}
        >
          <div className={styles.panelHeader}>
            <div className={`appPanelTopBar ${styles.panelToolbar}`}>
              <span className={styles.panelHeading}>Tree</span>
              <label className={styles.toolbarLabel}>
                <select
                  value={resolvedTreeIdValue}
                  onChange={(event) => {
                    const nextTreeId = event.target.value || null;
                    resetTreeSelectionState();
                    navigateToSelectionHref(getTreeSelectionHref(pathname, searchParams.toString(), nextTreeId, visibilityParam));
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
              <label className={styles.toolbarLabel}>
                <select
                  value={visibilityParam}
                  onChange={(event) => {
                    setError(null);
                    resetTreeSelectionState();
                    navigateToSelectionHref(getTreeSelectionHref(pathname, searchParams.toString(), null, event.target.value));
                  }}
                >
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                </select>
              </label>
              <button
                onClick={() => {
                  router.push("/trees");
                }}
                type="button"
                className="appCompactActionButton appCompactActionButtonNeutral"
              >
                Manage
              </button>
              <button
                onClick={handleAddRoot}
                disabled={!canAddRoot}
                type="button"
                className="appCompactActionButton appCompactActionButtonNeutral"
              >
                Add Root
              </button>
              <button
                onClick={handleAddChild}
                disabled={!canAddChild}
                type="button"
                className="appCompactActionButton appCompactActionButtonNeutral"
              >
                Add Child
              </button>
              <button
                onClick={handleGenerateChildren}
                disabled={!canGenerateChildren || isGeneratingChildren || isNodeDetailsBusy}
                type="button"
                className="appCompactActionButton appCompactActionButtonNeutral"
              >
                {isGeneratingChildren ? "Generating..." : "Generate"}
              </button>
              <button
                onClick={handleDelete}
                disabled={!canDelete}
                type="button"
                className="appCompactActionButton appCompactActionButtonDanger"
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
              height={resolvedTreeHeight}
              indent={24}
              rowHeight={TREE_ROW_HEIGHT}
              overscanCount={1}
              paddingTop={TREE_PADDING_TOP}
              paddingBottom={TREE_PADDING_BOTTOM}
              padding={25}
              onMove={handleMove}
              onToggle={handleToggle}
              onSelect={(nodes) => {
                const nextSelectedNode = nodes.length === 1 ? nodes[0].data : null;
                const nextSelectedNodeId = nextSelectedNode ? String(nextSelectedNode.id) : null;
                const currentSelectedNodeId = selectedNodeId ? String(selectedNodeId) : null;

                if (!nextSelectedNodeId && currentSelectedNodeId && findNodeById(treeData, currentSelectedNodeId)) {
                  return;
                }

                if (nextSelectedNodeId && nextSelectedNodeId === currentSelectedNodeId) {
                  return;
                }

                setSelectedNodeId(nextSelectedNodeId);
                const nextEditorState = buildNodeEditorState(nextSelectedNode ? {
                  name: nextSelectedNode.name,
                  isLeafNode: nextSelectedNode.isLeafNode,
                } : null);
                setNodeEditorState(nextEditorState);
                setSavedNodeEditorState(nextEditorState);
                setNodeDetailsError(null);
                setIsEditingNotes(false);
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
                const isSelected = String(node.data.id) === String(selectedNodeId);

                return (
                  <div
                    style={style}
                    ref={dragHandle}
                    className={[
                      styles.treeRow,
                      isSelected ? styles.treeRowSelected : "",
                      node.willReceiveDrop ? styles.treeRowDropTarget : "",
                    ].filter(Boolean).join(" ")}
                  >
                    <span className={styles.treeRowInset} aria-hidden="true" />
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
          className={`appPanelShell ${styles.panelShell}`}
          style={detailsPanelStyle}
        >
          <div className={styles.panelHeader}>
            <div className={`appPanelTopBar ${styles.panelToolbar} ${styles.detailsToolbar}`}>
              <span className={styles.panelHeading}>Node Details</span>
              <button
                onClick={handleSaveNodeDetails}
                disabled={!selectedNode || isSavingNodeDetails || isGeneratingNotes || !nodeEditorState.name.trim()}
                type="button"
                className="appCompactActionButton appCompactActionButtonPrimary"
              >
                {isSavingNodeDetails ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
          <div className={styles.detailsContent}>
            {!selectedNode ? (
              <div className={styles.detailsForm}>
                <div className={styles.emptyState}>
                  Select a node to edit its details.
                </div>
              </div>
            ) : (
              <div className={styles.detailsForm}>
                <label className={styles.formField}>
                  <span className="appFieldLabel">Name</span>
                  <input
                    type="text"
                    value={nodeEditorState.name}
                    onChange={(event) => handleNodeEditorChange("name", event.target.value)}
                    disabled={isNodeDetailsBusy}
                    className={`appTextControl ${styles.textInput}`}
                  />
                </label>
                {canEditLeafDetails ? (
                  <>
                    <div className={styles.formField}>
                      <span className="appFieldLabel">Notes</span>
                      <NotesEditor
                        value={nodeEditorState.notes}
                        onChange={(nextValue) => handleNodeEditorChange("notes", nextValue)}
                        disabled={isNodeDetailsBusy}
                        onGenerate={handleGenerateNotes}
                        isGenerating={isGeneratingNotes}
                        canGenerate={canGenerateNotes && isEditingNotes}
                        isEditing={isEditingNotes}
                        onStartEditing={handleStartEditingNotes}
                        onCancelEditing={handleCancelEditingNotes}
                      />
                    </div>
                    <section className={styles.attachmentSection}>
                      <div className={styles.attachmentSectionHeader}>
                        <span className="appFieldLabel">Attachments</span>
                        <span className={styles.attachmentHint}>Allowed up to 10 MB each.</span>
                      </div>
                      <div className={styles.attachmentPicker}>
                        <label className={`appCompactActionButton appCompactActionButtonNeutral ${isNodeDetailsBusy ? styles.pickerButtonDisabled : ""}`}>
                          <span>Choose files</span>
                          <input
                            ref={attachmentInputRef}
                            type="file"
                            multiple
                            accept={ATTACHMENT_ACCEPT}
                            onChange={handleAttachmentSelectionChange}
                            disabled={isNodeDetailsBusy}
                            className={styles.fileInputHidden}
                          />
                        </label>
                        <button
                          onClick={handleUploadAttachments}
                          disabled={isNodeDetailsBusy || pendingFiles.length === 0}
                          type="button"
                          className="appCompactActionButton appCompactActionButtonPrimary"
                        >
                          {isUploadingAttachments ? "Uploading..." : `Upload${pendingFiles.length ? ` (${pendingFiles.length})` : ""}`}
                        </button>
                        {pendingFiles.length > 0 ? (
                          <span className={styles.attachmentPickerStatus}>{pendingFiles.length} file{pendingFiles.length === 1 ? "" : "s"} selected</span>
                        ) : null}
                      </div>
                      {nodeEditorState.attachments.length === 0 ? (
                        <div className={styles.emptyState}>No files uploaded for this node.</div>
                      ) : (
                        <div className={styles.attachmentList}>
                          {nodeEditorState.attachments.map((attachment) => (
                            <div key={attachment.id} className={styles.attachmentItem}>
                              <div className={styles.attachmentMeta}>
                                {getAttachmentPreviewType(attachment) === "image" && getNodeAttachmentContentUrl(attachment) ? (
                                  <div className={styles.attachmentPreviewInline}>
                                    <Image
                                      src={getNodeAttachmentContentUrl(attachment)}
                                      alt={attachment.fileName || "Attachment preview"}
                                      width={240}
                                      height={180}
                                      sizes="240px"
                                      className={styles.attachmentPreviewInlineImage}
                                      unoptimized
                                    />
                                  </div>
                                ) : null}
                                <strong>{attachment.fileName}</strong>
                                <span className={styles.attachmentHint}>
                                  {formatAttachmentSize(attachment.byteSize)}
                                  {attachment.contentType ? ` • ${attachment.contentType}` : ""}
                                </span>
                              </div>
                              <div className={styles.attachmentActions}>
                                {getNodeAttachmentContentUrl(attachment) ? (
                                  <a
                                    href={getNodeAttachmentContentUrl(attachment)}
                                    target="_blank"
                                    rel="noreferrer"
                                    className={`appCompactActionButton appCompactActionButtonNeutral ${styles.attachmentActionLink}`}
                                  >
                                    Open
                                  </a>
                                ) : null}
                                <button
                                  onClick={() => handleDeleteAttachment(attachment.id)}
                                  disabled={isNodeDetailsBusy}
                                  type="button"
                                  className="appCompactActionButton appCompactActionButtonDanger"
                                >
                                  {deletingAttachmentId === String(attachment.id) ? "Deleting..." : "Delete file"}
                                </button>
                              </div>
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
