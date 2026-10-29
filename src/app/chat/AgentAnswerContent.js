"use client";

import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./page.module.css";

const IMAGE_FILE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
const AGENT_METADATA_PREFIX = "<!-- agent-meta: ";
const AGENT_METADATA_SUFFIX = " -->";
const PREVIEW_ID_LINE_PATTERN = /^<!-- Preview ID: [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12} -->$/i;
const EMAIL_UID_LINE_PATTERN = /^(?:<!-- Email UID: [0-9]+ -->|&lt;!-- Email UID: [0-9]+ --&gt;)$/;
const EMAIL_UID_COMMENT_PATTERN = /(?:<!-- Email UID: [0-9]+ -->|&lt;!-- Email UID: [0-9]+ --&gt;)/g;

function isAgentMetadataLine(line) {
  if (!line.startsWith(AGENT_METADATA_PREFIX) || !line.endsWith(AGENT_METADATA_SUFFIX)) {
    return false;
  }

  try {
    const metadata = JSON.parse(line.slice(AGENT_METADATA_PREFIX.length, -AGENT_METADATA_SUFFIX.length));
    return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) && Object.keys(metadata).length > 0;
  } catch {
    return false;
  }
}

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

    if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname.endsWith(".blob.core.windows.net")) {
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

function prepareAgentAnswer(answer) {
  return String(answer ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !isAgentMetadataLine(line) && !PREVIEW_ID_LINE_PATTERN.test(line) && !EMAIL_UID_LINE_PATTERN.test(line.trim()))
    .map((line) => line.replace(EMAIL_UID_COMMENT_PATTERN, ""))
    .join("\n")
    .trimEnd();
}

function answerUrlTransform(url) {
  const attachmentUrl = getInternalAttachmentContentUrl(url);

  if (attachmentUrl) {
    return attachmentUrl;
  }

  if (/^https?:\/\//i.test(url) || url.startsWith("/notes?")) {
    return url;
  }

  return "";
}

function AttachmentImage({ src, alt }) {
  const blobName = src?.startsWith("/api/attachments/content?blobName=")
    ? new URL(src, "http://localhost").searchParams.get("blobName")
    : null;
  const label = alt || blobName?.split("/").pop() || "Attachment preview";

  if (!blobName || !isImageUrlCandidate(blobName)) {
    return src ? <a href={src} target="_blank" rel="noreferrer" className={styles.inlineAttachmentLink}>{label}</a> : <span>{label}</span>;
  }

  return (
    <div className={styles.attachmentPreviewRow}>
      <div className={styles.attachmentPreviewDetails}>
        <span className={styles.attachmentPreviewFileName}>{label}</span>
      </div>
      <div className={styles.attachmentPreviewFrame}>
        <Image
          src={src}
          alt={label}
          width={240}
          height={180}
          sizes="240px"
          className={styles.attachmentPreviewImage}
          unoptimized
        />
      </div>
      <a href={src} target="_blank" rel="noreferrer" className={styles.attachmentOpenLink}>
        Open
      </a>
    </div>
  );
}

export function AgentAnswerContent({ answer, keyPrefix, textClassName }) {
  const heading = ({ node, children }) => {
    const Tag = node.tagName;
    return <Tag className={styles.messageHeading}>{children}</Tag>;
  };

  return (
    <ReactMarkdown
      key={keyPrefix}
      remarkPlugins={[remarkGfm]}
      urlTransform={answerUrlTransform}
      components={{
        p: ({ node, children }) => node.children.some((child) => child.type === "element" && child.tagName === "img")
          ? <div className={textClassName}>{children}</div>
          : <p className={textClassName}>{children}</p>,
        h1: heading,
        h2: heading,
        h3: heading,
        h4: heading,
        h5: heading,
        h6: heading,
        a: ({ href, children }) => href
          ? <a href={href} target="_blank" rel="noreferrer" className={styles.inlineAttachmentLink}>{children}</a>
          : <span>{children}</span>,
        img: ({ src, alt }) => <AttachmentImage src={src} alt={alt} />,
        table: ({ children }) => (
          <div className={styles.messageTableWrapper}>
            <table className={styles.messageTable}>{children}</table>
          </div>
        ),
      }}
    >
      {prepareAgentAnswer(answer)}
    </ReactMarkdown>
  );
}