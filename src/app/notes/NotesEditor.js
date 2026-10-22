"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import styles from "./NotesEditor.module.css";

const INSERT_GROUPS = [
  {
    titleKey: "Bullets",
    items: [
      { labelKey: "Bullet", preview: "•", insertText: "• " },
      { labelKey: "OpenBullet", preview: "◦", insertText: "◦ " },
      { labelKey: "SquareBullet", preview: "▪", insertText: "▪ " },
      { labelKey: "ArrowBullet", preview: "▸", insertText: "▸ " },
      { labelKey: "Dash", preview: "-", insertText: "- " },
    ],
  },
  {
    titleKey: "Status",
    items: [
      { labelKey: "Check", preview: "✓", insertText: "✓ " },
      { labelKey: "Cross", preview: "✗", insertText: "✗ " },
      { labelKey: "Warning", preview: "⚠️", insertText: "⚠️ " },
      { labelKey: "Question", preview: "❓", insertText: "❓ " },
      { labelKey: "Unchecked", preview: "☐", insertText: "☐ " },
      { labelKey: "Checked", preview: "☑", insertText: "☑ " },
    ],
  },
  {
    titleKey: "Templates",
    items: [
      { labelKey: "Action", preview: "Action:", insertText: "Action: " },
      { labelKey: "Decision", preview: "Decision:", insertText: "Decision: " },
      { labelKey: "Question", preview: "Question:", insertText: "Question: " },
      { labelKey: "Note", preview: "Note:", insertText: "Note: " },
      {
        labelKey: "TwoBulletsSub",
        preview: "• ◦ • ◦",
        insertText: "• \n   ◦ \n• \n   ◦ ",
      },
      {
        labelKey: "TwoBulletsTwoSubs",
        preview: "• ◦ ▪ •",
        insertText: "• \n   ◦ \n      ▪ \n• \n   ◦ \n      ▪ ",
      },
      {
        labelKey: "FourBullets",
        preview: "• • • •",
        insertText: "• \n• \n• \n• ",
      },
      {
        labelKey: "FourDashBullets",
        preview: "- - - -",
        insertText: "- \n- \n- \n- ",
      },
    ],
  },
];

export function NotesEditor({
  value,
  onChange,
  disabled,
  onGenerate = null,
  isGenerating = false,
  canGenerate = false,
  isEditing = false,
  onStartEditing = null,
  onCancelEditing = null,
}) {
  const t = useTranslations("Pages.Notes.Editor");
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
          className={styles.toolbarButton}
          onClick={onStartEditing}
          disabled={disabled || isEditing}
        >
          {t("Edit")}
        </button>
        <button
          type="button"
          className={styles.toolbarButton}
          onClick={() => {
            setIsPanelOpen((currentOpen) => !currentOpen);
          }}
          disabled={disabled || !isEditing}
          aria-expanded={isPanelOpen}
          aria-haspopup="dialog"
        >
          {t("Insert")}
        </button>
        {onGenerate ? (
          <button
            type="button"
            className={styles.toolbarButton}
            onClick={onGenerate}
            disabled={disabled || !isEditing || !canGenerate || isGenerating}
          >
            {t(isGenerating ? "Generating" : "Generate")}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.toolbarButton}
          onClick={() => {
            setIsPanelOpen(false);
            onCancelEditing?.();
          }}
          disabled={disabled || !isEditing}
        >
          {t("Cancel")}
        </button>
      </div>

      {isEditing && isPanelOpen && (
        <div className={styles.insertPanel} role="dialog" aria-label={t("InsertDialog")}>
          {INSERT_GROUPS.map((group) => (
            <section key={group.titleKey} className={styles.insertGroup}>
              <h3 className={styles.insertGroupTitle}>{t(`Groups.${group.titleKey}`)}</h3>
              <div className={styles.insertGrid}>
                {group.items.map((item) => (
                  <button
                    key={`${group.titleKey}-${item.labelKey}`}
                    type="button"
                    className={styles.insertItem}
                    disabled={disabled}
                    title={t(`Items.${item.labelKey}`)}
                    aria-label={t(`Items.${item.labelKey}`)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => {
                      insertTextAtCursor(item.insertText);
                    }}
                  >
                    <span className={styles.insertItemPreview}>{item.preview ?? item.insertText.trim()}</span>
                    <span className={styles.insertItemLabel}>{t(`Items.${item.labelKey}`)}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {isEditing ? (
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
      ) : (
        <div className={styles.readView}>
          {String(value || "").trim() ? value : <span className={styles.readViewEmpty}>{t("NoNotes")}</span>}
        </div>
      )}
    </div>
  );
}