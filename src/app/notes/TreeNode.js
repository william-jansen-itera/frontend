import styles from "./page.module.css";
import { useId } from "react";
import { useTranslations } from "next-intl";
import { LeafyGreen } from "lucide-react";
import { dataNodeHasChildren } from "./treeUtils";

export const TREE_INDENT = 24;
export const TREE_ROW_HEIGHT = 24;
const LINE_X = 8;
const CONTENT_OFFSET = 10;
const ROOT_OFFSET = 24;
const ROOT_CONNECTOR_LAYER = 1000;

function getNodeHash(id) {
  let hash = 2166136261;
  for (const character of String(id)) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return hash;
}

function getBranchBrightness(id) {
  return 0.75 + (getNodeHash(id) % 36) / 200;
}

export function TreeNode({ node, style, dragHandle, selectedNodeId }) {
  const t = useTranslations("Pages.Notes.Tree");
  const leafGradientId = useId();
  const nodeHash = getNodeHash(node.data.id);
  const isSelected = String(node.data.id) === String(selectedNodeId);
  const level = node.level;
  const isLeaf = Boolean(node.data.isLeafNode);
  const canToggle = !isLeaf && dataNodeHasChildren(node.data);
  const isRootRow = level === 0;

  return (
    <div
      style={{ ...style, paddingLeft: 0, height: TREE_ROW_HEIGHT, minHeight: TREE_ROW_HEIGHT, overflow: "visible", "--tree-branch-brightness": getBranchBrightness(node.data.id) }}
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
          "--tree-branch-brightness": 0.9,
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
              "--tree-branch-brightness": getBranchBrightness(pathNode.parent.data.id),
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
          {isLeaf ? (
            <LeafyGreen
              size={18}
              color="#15803d"
              fill={`url(#${leafGradientId})`}
              strokeWidth={2}
              style={{ transform: "translate(-7px, -2px) rotate(40deg)", filter: `saturate(0.7) brightness(${0.9 + (nodeHash % 41) / 160})` }}
              aria-hidden="true"
            >
              <defs>
                <linearGradient id={leafGradientId} x1="0%" y1="0%" x2="100%" y2="100%" gradientTransform={`rotate(${nodeHash % 360} 0.5 0.5)`}>
                  <stop offset="0%" stopColor="#dcfce7" />
                  <stop offset="60%" stopColor="#16a34a" />
                </linearGradient>
              </defs>
            </LeafyGreen>
          ) : "\u25B8"}
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