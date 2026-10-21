"use client";

import { Tree } from "react-arborist";

const INDENT = 28;
const ROW_HEIGHT = 32;
const LINE_X = 8;
const CONTENT_OFFSET = 14;
const ROOT_OFFSET = 16;

function TreeNode({ node, style, dragHandle }) {
  const level = node.level;

  return (
    <div
      ref={dragHandle}
      style={{
        ...style,
        paddingLeft: 0,
        display: "flex",
        alignItems: "center",
        position: "relative",
        height: ROW_HEIGHT,
        minHeight: ROW_HEIGHT,
        overflow: "visible",
        cursor: node.isInternal ? "pointer" : "default",
      }}
      onClick={() => node.isInternal && node.toggle()}
    >
      {/* Root-level connector — continues through the last root like a trunk */}
      {(() => {
        let root = node;
        while (root.parent && root.level > 0) root = root.parent;

        const isLastRoot = root.nextSibling == null;
        const isRootRow = level === 0;

        // Always draw, including for the last root
        return (
          <div
            style={{
              position: "absolute",
              left: 4,
              top: isRootRow ? ROW_HEIGHT / 2 : -16,
              // Last root’s final rows get a little extra length so it “hits the ground”
              height: isLastRoot
                ? (isRootRow ? ROW_HEIGHT : ROW_HEIGHT + 48)
                : (isRootRow ? ROW_HEIGHT / 2 + 16 : ROW_HEIGHT + 32),
              width: 5,
              borderTopLeftRadius: 2.5,
              borderTopRightRadius: 2.5,
              backgroundColor: "#8d8277",
              pointerEvents: "none",
            }}
          />
        );
      })()}
      {/* Short horizontal stub on root rows */}
      {level === 0 && (
        <div
          style={{
            position: "absolute",
            left: 4,
            top: ROW_HEIGHT / 2 + 1,
            width: 24,
            height: 4,
            borderTopRightRadius: 2,
            borderBottomRightRadius: 2,
            borderTopLeftRadius: node.childIndex === 0 ? 2 : 0,  // only the first root
            backgroundColor: "#8d8277",
            transform: "translateY(-50%)",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
      )}

      {/* Ancestor vertical lines */}
      {Array.from({ length: level }).map((_, i) => {
        const isImmediateParent = i === level - 1;

        let shouldDraw = true;
        if (!isImmediateParent) {
          let pathNode = node;
          for (let step = level; step > i + 1; step--) {
            pathNode = pathNode.parent;
          }
          shouldDraw = pathNode?.nextSibling != null;
        }

        if (!shouldDraw) return null;

        const isLastOfMany = node.nextSibling === null && node.childIndex > 0;
        const parentHasOneChild = node.parent && node.parent.children?.length === 1;
        const useExact = isImmediateParent && (isLastOfMany || parentHasOneChild);

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: ROOT_OFFSET + i * INDENT + LINE_X,
              top: -16,
              height: useExact ? ROW_HEIGHT : ROW_HEIGHT + 32,
              width: Math.max(1, 4 - i * 2),
              borderTopLeftRadius: 2,
              borderTopRightRadius: 2,
              backgroundColor: "#8d8277",
              pointerEvents: "none",
              zIndex: 1,
            }}
          />
        );
      })}

      {/* Horizontal connector */}
      {level > 0 && (
        <div
          style={{
            position: "absolute",
            left: ROOT_OFFSET + (level - 1) * INDENT + LINE_X,
            top: ROW_HEIGHT / 2,
            width: INDENT - LINE_X + (level >= 2 ? 9 : 10),
            borderTopRightRadius: 2,
            borderBottomRightRadius: 2,
            borderBottomLeftRadius: 2,
            height: Math.max(1, 3 - (level - 1) * 2),
            backgroundColor: "#8d8277",
            transform: "translateY(-50%)",
            pointerEvents: "none",
          }}
        />
      )}

      {/* Icon + label */}
      <span
        style={{
          marginLeft: level === 0
            ? ROOT_OFFSET + 16
            : ROOT_OFFSET + level * INDENT + CONTENT_OFFSET - (node.isLeaf ? 10 : 0),
          marginRight: 6,
          fontSize: "1.1em",
          flexShrink: 0,
          position: "relative",
          zIndex: 1,
        }}
      >
        {node.isLeaf ? "🍃" : node.isOpen ? "▾" : "▸"}
      </span>
      <span
        style={{
          color: node.isLeaf ? "#266247" : "#3f3534",
          fontWeight: level === 0 ? 600 : 400,
          position: "relative",
          zIndex: 1,
        }}
      >
        {node.data.name}
      </span>
    </div>
  );
}

export function TreeView({ data }) {
  return (
    <div style={{ overflow: "visible" }}>
      <Tree
        data={data}
        indent={INDENT}
        rowHeight={ROW_HEIGHT}
        openByDefault={false}
        width="100%"
        height={500}
      >
        {TreeNode}
      </Tree>
    </div>
  );
}