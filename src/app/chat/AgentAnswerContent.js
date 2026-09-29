"use client";

import Image from "next/image";
import styles from "./page.module.css";

const IMAGE_FILE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);

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

function buildAgentAnswerBlocks(answer) {
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

    if (block.type === "inline") {
      return (
        <p key={`${keyPrefix}-text-${index}`} className={textClassName}>
          {block.segments.map((segment, segmentIndex) => {
            if (segment.type === "attachmentLink") {
              return (
                <a
                  key={`${keyPrefix}-link-${index}-${segmentIndex}`}
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
              <span key={`${keyPrefix}-segment-${index}-${segmentIndex}`}>
                {segment.content}
              </span>
            );
          })}
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