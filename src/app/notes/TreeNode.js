import styles from "./page.module.css";
import { dataNodeHasChildren } from "./treeUtils";

export function TreeNode({ node, style, dragHandle, selectedNodeId }) {
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
}