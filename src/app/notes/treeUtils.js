import { adjustMoveIndex } from "react-arborist";

export function buildNestedTreeData(flatData) {
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

export function flattenTreeData(nodes, parentId = null) {
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

export function collectExpandableNodeIds(nodes) {
  return nodes.flatMap((node) => {
    const childIds = node.children ? collectExpandableNodeIds(node.children) : [];
    return node.isLeafNode ? childIds : [String(node.id), ...childIds];
  });
}

export function extractExpandedState(flatData) {
  return flatData.reduce((nextExpandedState, node) => {
    if (!node.isLeafNode && node.isExpanded) {
      nextExpandedState[String(node.id)] = true;
    }

    return nextExpandedState;
  }, {});
}

export function expandPathToNode(flatData, expandedState, targetNodeId) {
  if (!targetNodeId) {
    return expandedState;
  }

  const nodeById = new Map(flatData.map((node) => [String(node.id), node]));
  const nextExpandedState = { ...expandedState };
  let currentNode = nodeById.get(String(targetNodeId));

  while (currentNode?.parent !== null && currentNode?.parent !== undefined) {
    const parentId = String(currentNode.parent);
    const parentNode = nodeById.get(parentId);

    if (!parentNode) {
      break;
    }

    if (!parentNode.isLeafNode) {
      nextExpandedState[parentId] = true;
    }

    currentNode = parentNode;
  }

  return nextExpandedState;
}

export function getAncestorExpandableNodeIds(flatData, targetNodeId) {
  if (!targetNodeId) {
    return [];
  }

  const nodeById = new Map(flatData.map((node) => [String(node.id), node]));
  const ancestorIds = [];
  let currentNode = nodeById.get(String(targetNodeId));

  while (currentNode?.parent !== null && currentNode?.parent !== undefined) {
    const parentId = String(currentNode.parent);
    const parentNode = nodeById.get(parentId);

    if (!parentNode) {
      break;
    }

    if (!parentNode.isLeafNode) {
      ancestorIds.push(parentId);
    }

    currentNode = parentNode;
  }

  return ancestorIds;
}

export function findNodeById(nodes, targetId) {
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

export function getNextSelectedNodeId(flatData, currentSelectedNodeId, targetSelectedNodeId = null) {
  const nextSelectedNodeId = targetSelectedNodeId ?? currentSelectedNodeId;
  if (!nextSelectedNodeId) {
    return null;
  }

  const matchingNode = flatData.find((node) => String(node.id) === String(nextSelectedNodeId));
  return matchingNode ? String(nextSelectedNodeId) : null;
}

export function getTreeSelectionHref(pathname, searchParamsString, nextTreeId, visibility = null) {
  const nextSearchParams = new URLSearchParams(searchParamsString);

  if (visibility && visibility !== "public") {
    nextSearchParams.set("visibility", visibility);
  } else {
    nextSearchParams.delete("visibility");
  }

  if (nextTreeId) {
    nextSearchParams.set("treeId", String(nextTreeId));
    nextSearchParams.delete("nodeId");
  } else {
    nextSearchParams.delete("treeId");
    nextSearchParams.delete("nodeId");
  }

  const nextQueryString = nextSearchParams.toString();
  return nextQueryString ? `${pathname}?${nextQueryString}` : pathname;
}

export function dataNodeHasChildren(dataNode) {
  return Array.isArray(dataNode?.children) && dataNode.children.length > 0;
}

export function dataNodeHasLeafDescendants(dataNode) {
  if (!Array.isArray(dataNode?.children) || dataNode.children.length === 0) {
    return false;
  }

  return dataNode.children.some((childNode) => childNode.isLeafNode || dataNodeHasLeafDescendants(childNode));
}

export function buildNodeEditorState(nodeDetails = null) {
  return {
    name: nodeDetails?.name ?? "",
    notes: nodeDetails?.notes ?? "",
    attachments: Array.isArray(nodeDetails?.attachments) ? nodeDetails.attachments : [],
  };
}

export function buildMovedFlatData(treeData, { dragIds, parentId, index }) {
  const flatData = flattenTreeData(treeData).map((node) => ({ ...node }));
  const draggedIdSet = new Set(dragIds.map(String));
  const draggedNodes = flatData.filter((node) => draggedIdSet.has(String(node.id)));

  if (draggedNodes.length === 0) {
    return { didPositionChange: false, flatData };
  }

  const existingParentId = draggedNodes[0].parent;
  const sourceSiblingIds = flatData
    .filter((node) => node.parent == existingParentId)
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((node) => String(node.id));
  const destinationSiblingIds = flatData
    .filter((node) => node.parent == parentId)
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((node) => String(node.id));
  const adjustedIndex = adjustMoveIndex({
    index,
    dragIds: dragIds.map(String),
    siblingIds: destinationSiblingIds,
  });
  const existingIndex = sourceSiblingIds.findIndex((id) => draggedIdSet.has(id));

  const didPositionChange = !(existingParentId == parentId && existingIndex === adjustedIndex);
  if (!didPositionChange) {
    return { didPositionChange, flatData };
  }

  const siblingGroups = new Map();

  flatData.forEach((node) => {
    const key = node.parent == null ? "__root__" : String(node.parent);
    const siblings = siblingGroups.get(key) ?? [];
    siblings.push(node);
    siblingGroups.set(key, siblings);
  });

  siblingGroups.forEach((siblings) => {
    siblings.sort((left, right) => left.sort_order - right.sort_order);
  });

  const sourceKey = existingParentId == null ? "__root__" : String(existingParentId);
  const destinationKey = parentId == null ? "__root__" : String(parentId);
  const sourceSiblings = siblingGroups.get(sourceKey) ?? [];
  const destinationSiblings = siblingGroups.get(destinationKey) ?? [];
  const movedSiblings = sourceSiblings.filter((node) => draggedIdSet.has(String(node.id)));

  siblingGroups.set(
    sourceKey,
    sourceSiblings.filter((node) => !draggedIdSet.has(String(node.id))),
  );

  movedSiblings.forEach((node) => {
    node.parent = parentId;
  });

  const insertionSiblings = sourceKey === destinationKey
    ? siblingGroups.get(sourceKey) ?? []
    : destinationSiblings;

  insertionSiblings.splice(adjustedIndex, 0, ...movedSiblings);
  siblingGroups.set(destinationKey, insertionSiblings);

  siblingGroups.forEach((siblings) => {
    siblings.forEach((node, siblingIndex) => {
      node.sort_order = siblingIndex;
    });
  });

  return { didPositionChange, flatData };
}