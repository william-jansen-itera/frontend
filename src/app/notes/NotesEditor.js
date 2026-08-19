"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./NotesEditor.module.css";

const INSERT_GROUPS = [
  {
    title: "Bullets",
    items: [
      { label: "Bullet", preview: "•", insertText: "• " },
      { label: "Open bullet", preview: "◦", insertText: "◦ " },
      { label: "Square bullet", preview: "▪", insertText: "▪ " },
      { label: "Arrow bullet", preview: "▸", insertText: "▸ " },
      { label: "Dash", preview: "-", insertText: "- " },
    ],
  },
  {
    title: "Status",
    items: [
      { label: "Check", preview: "✓", insertText: "✓ " },
      { label: "Cross", preview: "✗", insertText: "✗ " },
      { label: "Warning", preview: "⚠️", insertText: "⚠️ " },
      { label: "Question", preview: "❓", insertText: "❓ " },
      { label: "Unchecked", preview: "☐", insertText: "☐ " },
      { label: "Checked", preview: "☑", insertText: "☑ " },
    ],
  },
  {
    title: "Templates",
    items: [
      { label: "Action", preview: "Action:", insertText: "Action: " },
      { label: "Decision", preview: "Decision:", insertText: "Decision: " },
      { label: "Question", preview: "Question:", insertText: "Question: " },
      { label: "Note", preview: "Note:", insertText: "Note: " },
      {
        label: "2 bullets + sub",
        preview: "• ◦ • ◦",
        insertText: "• \n   ◦ \n• \n   ◦ ",
      },
      {
        label: "2 bullets + sub + sub",
        preview: "• ◦ ▪ •",
        insertText: "• \n   ◦ \n      ▪ \n• \n   ◦ \n      ▪ ",
      },
      {
        label: "4 bullets",
        preview: "• • • •",
        insertText: "• \n• \n• \n• ",
      },
      {
        label: "4 dash bullets",
        preview: "- - - -",
        insertText: "- \n- \n- \n- ",
      },
    ],
  },
];

export function NotesEditor({ value, onChange, disabled, onGenerate = null, isGenerating = false, canGenerate = false }) {
  const editorRef = useRef(null);
  const textareaRef = useRef(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  useEffect(() => {
    if (!isPanelOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!editorRef.current?.contains(event.target)) {
        setIsPanelOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isPanelOpen]);

  const rememberSelection = () => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    selectionRef.current = {
      start: textarea.selectionStart ?? 0,
      end: textarea.selectionEnd ?? 0,
    };
  };

  const handleChange = (event) => {
    rememberSelection();
    onChange(event.target.value);
  };

  const insertTextAtCursor = (insertText) => {
    const textarea = textareaRef.current;
    const currentValue = value ?? "";
    const start = textarea ? (textarea.selectionStart ?? 0) : selectionRef.current.start;
    const end = textarea ? (textarea.selectionEnd ?? start) : selectionRef.current.end;
    const nextValue = `${currentValue.slice(0, start)}${insertText}${currentValue.slice(end)}`;
    const nextCursorPosition = start + insertText.length;

    onChange(nextValue);
    selectionRef.current = { start: nextCursorPosition, end: nextCursorPosition };

    requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;

      if (!nextTextarea) {
        return;
      }

      nextTextarea.focus();
      nextTextarea.setSelectionRange(nextCursorPosition, nextCursorPosition);
    });
  };

  return (
    <div ref={editorRef} className={styles.editorShell}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.insertButton}
          onClick={() => {
            setIsPanelOpen((currentOpen) => !currentOpen);
          }}
          disabled={disabled}
          aria-expanded={isPanelOpen}
          aria-haspopup="dialog"
        >
          Insert
        </button>
        {onGenerate ? (
          <button
            type="button"
            className={styles.insertButton}
            onClick={onGenerate}
            disabled={disabled || !canGenerate || isGenerating}
          >
            {isGenerating ? "Generating..." : "Generate"}
          </button>
        ) : null}
      </div>

      {isPanelOpen && (
        <div className={styles.insertPanel} role="dialog" aria-label="Insert symbols and templates">
          {INSERT_GROUPS.map((group) => (
            <section key={group.title} className={styles.insertGroup}>
              <h3 className={styles.insertGroupTitle}>{group.title}</h3>
              <div className={styles.insertGrid}>
                {group.items.map((item) => (
                  <button
                    key={`${group.title}-${item.label}`}
                    type="button"
                    className={styles.insertItem}
                    disabled={disabled}
                    title={item.label}
                    aria-label={item.label}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => {
                      insertTextAtCursor(item.insertText);
                    }}
                  >
                    <span className={styles.insertItemPreview}>{item.preview ?? item.insertText.trim()}</span>
                    <span className={styles.insertItemLabel}>{item.label}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onBlur={rememberSelection}
        onClick={rememberSelection}
        onKeyUp={rememberSelection}
        onSelect={rememberSelection}
        disabled={disabled}
        rows={12}
        className={styles.textArea}
      />
    </div>
  );
}