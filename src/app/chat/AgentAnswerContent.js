"use client";

import Image from "next/image";
import styles from "./page.module.css";

const IMAGE_FILE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
const MARKDOWN_TABLE_SEPARATOR_PATTERN = /^:?-{3,}:?$/;

function getImageExtension(candidate) {
  const normalizedCandidate = String(candidate ?? "").trim().toLowerCase();

  if (!normalizedCandidate) {
    return "";
  }

  const sanitizedCandidate = normalizedCandidate.split("?")[0].split("#")[0];

  if (!sanitizedCandidate.includes(".")) {
    return "";
  }

  return sanitizedCandidate.slice(sanitizedCandidate.lastIndexOf(".") + 1);
}

function isImageUrlCandidate(candidate) {
  return IMAGE_FILE_EXTENSIONS.has(getImageExtension(candidate));
}

function getInternalAttachmentContentUrl(rawUrl) {
  try {
    const parsedUrl = new URL(String(rawUrl ?? ""));
    const pathSegments = parsedUrl.pathname.split("/").map((part) => part.trim()).filter(Boolean);

    if (!parsedUrl.hostname.endsWith(".blob.core.windows.net")) {
      return null;
    }

    if (pathSegments[0] !== "node-attachments" || pathSegments.length < 2) {
      return null;
    }

    const blobName = pathSegments.slice(1).join("/");

    if (!blobName) {
      return null;
    }

    return `/api/attachments/content?blobName=${encodeURIComponent(blobName)}`;
  } catch {
    return null;
  }
}

function getAttachmentFileNameFromUrl(rawUrl) {
  try {
    const parsedUrl = new URL(String(rawUrl ?? ""));
    const pathSegments = parsedUrl.pathname.split("/").map((part) => part.trim()).filter(Boolean);
    return pathSegments[pathSegments.length - 1] || "Attachment preview";
  } catch {
    return "Attachment preview";
  }
}

function getAttachmentLinkLabel(rawLabel, rawUrl) {
  const normalizedLabel = String(rawLabel ?? "").trim();

  if (normalizedLabel) {
    return normalizedLabel;
  }

  return getAttachmentFileNameFromUrl(rawUrl);
}

function splitMarkdownTableRow(rawLine) {
  const normalizedLine = String(rawLine ?? "").trim();

  if (!normalizedLine.startsWith("|") || !normalizedLine.endsWith("|")) {
    return null;
  }

  return normalizedLine.slice(1, -1).split("|").map((cell) => cell.trim());
}

function isMarkdownTableSeparatorRow(rawLine) {
  const cells = splitMarkdownTableRow(rawLine);

  return Array.isArray(cells)
    && cells.length > 0
    && cells.every((cell) => MARKDOWN_TABLE_SEPARATOR_PATTERN.test(cell.replace(/\s+/g, "")));
}

function isMarkdownTableHeaderRow(rawLine) {
  const cells = splitMarkdownTableRow(rawLine);
  return Array.isArray(cells) && cells.length >= 2;
}

function normalizeTableCells(cells, targetLength) {
  const normalizedCells = Array.isArray(cells) ? [...cells] : [];

  while (normalizedCells.length < targetLength) {
    normalizedCells.push("");
  }

  return normalizedCells.slice(0, targetLength);
}

function buildInlineBlocks(answer) {
  const normalizedAnswer = String(answer ?? "");
  const attachmentPattern = /(!)?\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
  const blocks = [];
  let inlineSegments = [];
  let cursor = 0;
  let match = attachmentPattern.exec(normalizedAnswer);

  const pushInlineText = (content) => {
    if (!content) {
      return;
    }

    inlineSegments.push({
      type: "text",
      content,
    });
  };

  const flushInlineSegments = () => {
    if (inlineSegments.length === 0) {
      return;
    }

    blocks.push({
      type: "inline",
      segments: inlineSegments,
    });
    inlineSegments = [];
  };

  while (match) {
    const [fullMatch, isImageToken, label, attachmentUrl] = match;
    const contentUrl = getInternalAttachmentContentUrl(attachmentUrl);
    const textBefore = normalizedAnswer.slice(cursor, match.index);

    pushInlineText(textBefore);

    if (contentUrl && isImageToken && isImageUrlCandidate(attachmentUrl)) {
      flushInlineSegments();

      blocks.push({
        type: "image",
        alt: getAttachmentLinkLabel(label, attachmentUrl),
        src: contentUrl,
        fileName: getAttachmentFileNameFromUrl(attachmentUrl),
      });
      cursor = match.index + fullMatch.length;
      match = attachmentPattern.exec(normalizedAnswer);
      continue;
    }

    if (contentUrl) {
      inlineSegments.push({
        type: "attachmentLink",
        href: contentUrl,
        label: getAttachmentLinkLabel(label, attachmentUrl),
      });
      cursor = match.index + fullMatch.length;
      match = attachmentPattern.exec(normalizedAnswer);
      continue;
    }

    pushInlineText(fullMatch);
    cursor = match.index + fullMatch.length;
    match = attachmentPattern.exec(normalizedAnswer);
  }

  const trailingText = normalizedAnswer.slice(cursor);

  pushInlineText(trailingText);
  flushInlineSegments();

  return blocks.length > 0 ? blocks : [{ type: "inline", segments: [{ type: "text", content: normalizedAnswer }] }];
}

function buildAgentAnswerBlocks(answer) {
  const normalizedAnswer = String(answer ?? "").replace(/\r\n?/g, "\n");
  const lines = normalizedAnswer.split("\n");
  const blocks = [];
  let textBuffer = [];

  const flushTextBuffer = () => {
    if (textBuffer.length === 0) {
      return;
    }

    blocks.push(...buildInlineBlocks(textBuffer.join("\n")));
    textBuffer = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index];
    const nextLine = lines[index + 1] ?? "";

    if (isMarkdownTableHeaderRow(currentLine) && isMarkdownTableSeparatorRow(nextLine)) {
      flushTextBuffer();

      const headerCells = splitMarkdownTableRow(currentLine) ?? [];
      const rows = [];
      index += 2;

      while (index < lines.length) {
        const rowCells = splitMarkdownTableRow(lines[index]);

        if (!rowCells) {
          index -= 1;
          break;
        }

        rows.push(normalizeTableCells(rowCells, headerCells.length));
        index += 1;
      }

      blocks.push({
        type: "table",
        headers: headerCells,
        rows,
      });
      continue;
    }

    textBuffer.push(currentLine);
  }

  flushTextBuffer();

  return blocks.length > 0 ? blocks : buildInlineBlocks(normalizedAnswer);
}

function renderInlineSegments(segments, keyPrefix, blockIndex) {
  return segments.map((segment, segmentIndex) => {
    if (segment.type === "attachmentLink") {
      return (
        <a
          key={`${keyPrefix}-link-${blockIndex}-${segmentIndex}`}
          href={segment.href}
          target="_blank"
          rel="noreferrer"
          className={styles.inlineAttachmentLink}
        >
          {segment.label}
        </a>
      );
    }

    return (
      <span key={`${keyPrefix}-segment-${blockIndex}-${segmentIndex}`}>
        {segment.content}
      </span>
    );
  });
}

export function AgentAnswerContent({ answer, keyPrefix, textClassName }) {
  return buildAgentAnswerBlocks(answer).map((block, index) => {
    if (block.type === "image") {
      return (
        <div key={`${keyPrefix}-image-${index}`} className={styles.attachmentPreviewRow}>
          <div className={styles.attachmentPreviewDetails}>
            <span className={styles.attachmentPreviewFileName}>{block.alt}</span>
          </div>
          <div className={styles.attachmentPreviewFrame}>
            <Image
              src={block.src}
              alt={block.alt}
              width={240}
              height={180}
              sizes="240px"
              className={styles.attachmentPreviewImage}
              unoptimized
            />
          </div>
          <a
            href={block.src}
            target="_blank"
            rel="noreferrer"
            className={styles.attachmentOpenLink}
          >
            Open
          </a>
        </div>
      );
    }

    if (block.type === "table") {
      return (
        <div key={`${keyPrefix}-table-${index}`} className={styles.messageTableWrapper}>
          <table className={styles.messageTable}>
            <thead>
              <tr>
                {block.headers.map((header, headerIndex) => (
                  <th key={`${keyPrefix}-table-${index}-header-${headerIndex}`}>
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${keyPrefix}-table-${index}-row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${keyPrefix}-table-${index}-cell-${rowIndex}-${cellIndex}`}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    if (block.type === "inline") {
      return (
        <p key={`${keyPrefix}-text-${index}`} className={textClassName}>
          {renderInlineSegments(block.segments, keyPrefix, index)}
        </p>
      );
    }

    return (
      <p key={`${keyPrefix}-text-${index}`} className={textClassName}>
        {block.content}
      </p>
    );
  });
}