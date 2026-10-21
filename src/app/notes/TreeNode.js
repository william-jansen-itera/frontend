import styles from "./page.module.css";
import { dataNodeHasChildren } from "./treeUtils";

export const TREE_INDENT = 28;
export const TREE_ROW_HEIGHT = 32;
const LINE_X = 8;
const CONTENT_OFFSET = 14;
const ROOT_OFFSET = 16;

export function TreeNode({ node, style, dragHandle, selectedNodeId }) {
  const isSelected = String(node.data.id) === String(selectedNodeId);
  const level = node.level;
  const isLeaf = Boolean(node.data.isLeafNode);
  const canToggle = !isLeaf && dataNodeHasChildren(node.data);
  let root = node;

  while (root.parent && root.level > 0) {
    root = root.parent;
  }

  return (
    <div
      style={{ ...style, paddingLeft: 0, height: TREE_ROW_HEIGHT, minHeight: TREE_ROW_HEIGHT, overflow: "visible" }}
      ref={dragHandle}
      className={[
        styles.treeRow,
        isSelected ? styles.treeRowSelected : "",
        node.willReceiveDrop ? styles.treeRowDropTarget : "",
      ].filter(Boolean).join(" ")}
    >
      {root.nextSibling != null && (
        <span
          aria-hidden="true"
          className={styles.treeConnector}
          style={{ left: 4, top: -16, height: TREE_ROW_HEIGHT + 32, width: 5, borderRadius: "2.5px 2.5px 0 0" }}
        />
      )}
      {level === 0 && (
        <span
          aria-hidden="true"
          className={`${styles.treeConnector} ${styles.treeConnectorHorizontal}`}
          style={{ left: 4, top: TREE_ROW_HEIGHT / 2 + 1, width: 24, height: 4 }}
        />
      )}
      {Array.from({ length: level }, (_, depth) => {
        const isImmediateParent = depth === level - 1;
        let pathNode = node;

        if (!isImmediateParent) {
          for (let step = level; step > depth + 1; step--) {
            pathNode = pathNode.parent;
          }
        }

        if (!isImmediateParent && pathNode?.nextSibling == null) {
          return null;
        }

        const isLastOfMany = node.nextSibling === null && node.childIndex > 0;
        const parentHasOneChild = node.parent && node.parent.children?.length === 1;
        const useExact = isImmediateParent && (isLastOfMany || parentHasOneChild);

        return (
          <span
            key={depth}
            aria-hidden="true"
            className={styles.treeConnector}
            style={{
              left: ROOT_OFFSET + depth * TREE_INDENT + LINE_X,
              top: -16,
              height: useExact ? TREE_ROW_HEIGHT : TREE_ROW_HEIGHT + 32,
              width: Math.max(1, 4 - depth * 2),
              borderRadius: "2px 2px 0 0",
              zIndex: 1,
            }}
          />
        );
      })}
      {level > 0 && (
        <span
          aria-hidden="true"
          className={`${styles.treeConnector} ${styles.treeConnectorHorizontal}`}
          style={{
            left: ROOT_OFFSET + (level - 1) * TREE_INDENT + LINE_X,
            top: TREE_ROW_HEIGHT / 2,
            width: TREE_INDENT - LINE_X + (level >= 2 ? 9 : 10),
            height: Math.max(1, 3 - (level - 1) * 2),
          }}
        />
      )}
      {canToggle ? (
        <button
          type="button"
          className={styles.treeToggle}
          style={{ marginLeft: level === 0 ? ROOT_OFFSET + 16 : ROOT_OFFSET + level * TREE_INDENT + CONTENT_OFFSET }}
          aria-label={`${node.isOpen ? "Collapse" : "Expand"} ${node.data.name}`}
          aria-expanded={node.isOpen}
          onClick={(event) => {
            event.stopPropagation();
            node.toggle();
          }}
        >
          {node.isOpen ? "\u25BE" : "\u25B8"}
        </button>
      ) : (
        <span
          className={styles.treeMarker}
          style={{ marginLeft: level === 0 ? ROOT_OFFSET + 16 : ROOT_OFFSET + level * TREE_INDENT + CONTENT_OFFSET - (isLeaf ? 10 : 0) }}
          aria-hidden="true"
        >
          {isLeaf ? "\uD83C\uDF43" : "\u25B8"}
        </span>
      )}
      <span className={`${styles.treeRowLabel} ${isLeaf ? styles.treeLeafLabel : ""} ${level === 0 ? styles.treeRootLabel : ""}`}>
        {node.data.name}
      </span>
      {node.willReceiveDrop && !node.data.isLeafNode && (
        <span className={styles.treeDropHint}>Drop into node</span>
      )}
    </div>
  );
}