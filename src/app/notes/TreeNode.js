import styles from "./page.module.css";
import { useTranslations } from "next-intl";
import { dataNodeHasChildren } from "./treeUtils";

export const TREE_INDENT = 24;
export const TREE_ROW_HEIGHT = 24;
const LINE_X = 8;
const CONTENT_OFFSET = 10;
const ROOT_OFFSET = 24;
const ROOT_CONNECTOR_LAYER = 1000;

export function TreeNode({ node, style, dragHandle, selectedNodeId }) {
  const t = useTranslations("Pages.Notes.Tree");
  const isSelected = String(node.data.id) === String(selectedNodeId);
  const level = node.level;
  const isLeaf = Boolean(node.data.isLeafNode);
  const canToggle = !isLeaf && dataNodeHasChildren(node.data);
  const isRootRow = level === 0;

  return (
    <div
      style={{ ...style, paddingLeft: 0, height: TREE_ROW_HEIGHT, minHeight: TREE_ROW_HEIGHT, overflow: "visible" }}
      ref={dragHandle}
      onClick={node.handleClick}
      className={[
        styles.treeRow,
        isSelected ? styles.treeRowSelected : "",
        node.willReceiveDrop ? styles.treeRowDropTarget : "",
      ].filter(Boolean).join(" ")}
    >
      <span
        aria-hidden="true"
        className={styles.treeConnector}
        style={{
          left: 4,
          top: TREE_ROW_HEIGHT / 2 - 3,
          height: TREE_ROW_HEIGHT + 5,
          width: 16,
          borderRadius: isRootRow && node.childIndex === 0 ? "5px 0 0 0" : 0,
          zIndex: ROOT_CONNECTOR_LAYER,
        }}
      />
      {level === 0 && (
        <span
          aria-hidden="true"
          className={`${styles.treeConnector} ${styles.treeConnectorHorizontal}`}
          style={{ left: 4, top: TREE_ROW_HEIGHT / 2 + 1, width: 34, height: 8, borderTopLeftRadius: node.childIndex === 0 ? 5 : 0, zIndex: ROOT_CONNECTOR_LAYER - 1 }}
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
              top: (-TREE_ROW_HEIGHT / 2) - (level == 1 ? 2 : 0) - (level == 2 ? 1 : 0),
              height: (useExact ? TREE_ROW_HEIGHT : TREE_ROW_HEIGHT * 2) + (level == 1 ? 4 : 0) + (level == 2 ? 2 : 0),
              width: Math.max(1, 6 - depth * 2),
              borderRadius: "2px 2px 0px 2px",
              zIndex: ROOT_CONNECTOR_LAYER - 2 * depth - 2,
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
            width: TREE_INDENT - LINE_X + (level >= 2 ? 10 : 12),
            height: Math.max(1, 6 - (level - 1) * 2),
            zIndex: ROOT_CONNECTOR_LAYER - 2 * level - 1,
          }}
        />
      )}
      {canToggle ? (
        <button
          type="button"
          className={styles.treeToggle}
          style={{ marginLeft: level === 0 ? ROOT_OFFSET + 12 : ROOT_OFFSET + level * TREE_INDENT + CONTENT_OFFSET - (level >= 2 ? 2 : 0) }}
          aria-label={t(node.isOpen ? "Collapse" : "Expand", { name: node.data.name })}
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
          style={{ marginLeft: level === 0 ? ROOT_OFFSET + 12 : ROOT_OFFSET + level * TREE_INDENT + CONTENT_OFFSET - (isLeaf ? 2 : 0), visibility: isLeaf ? undefined : "hidden" }}
          aria-hidden="true"
        >
          {isLeaf ? "\uD83C\uDF43" : "\u25B8"}
        </span>
      )}
      <span className={`${styles.treeRowLabel} ${isLeaf ? styles.treeLeafLabel : ""}`}>
        {node.data.name}
      </span>
      {node.willReceiveDrop && !node.data.isLeafNode && (
        <span className={styles.treeDropHint}>{t("DropIntoNode")}</span>
      )}
    </div>
  );
}