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

export function getTreeSelectionHref(pathname, searchParamsString, nextTreeId) {
  const nextSearchParams = new URLSearchParams(searchParamsString);

  if (nextTreeId) {
    nextSearchParams.set("treeId", String(nextTreeId));
  } else {
    nextSearchParams.delete("treeId");
  }

  const nextQueryString = nextSearchParams.toString();
  return nextQueryString ? `${pathname}?${nextQueryString}` : pathname;
}

export function dataNodeHasChildren(dataNode) {
  return Array.isArray(dataNode?.children) && dataNode.children.length > 0;
}

export function buildNodeEditorState(nodeDetails = null) {
  return {
    name: nodeDetails?.name ?? "",
    description: nodeDetails?.description ?? "",
    notes: nodeDetails?.notes ?? "",
  };
}

export function buildMovedFlatData(treeData, { dragIds, parentId, index }) {
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

  const didPositionChange = !(existingParentId == parentId && existingIndex == index);
  if (!didPositionChange) {
    return { didPositionChange, flatData };
  }

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

  return { didPositionChange, flatData };
}