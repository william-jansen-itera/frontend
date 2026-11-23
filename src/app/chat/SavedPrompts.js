"use client";

import { useId, useRef, useState } from "react";
import { MessageSquareMore, MessageSquarePlus, Trash } from "lucide-react";
import { useTranslations } from "next-intl";
import { parseApiResponseBody } from "./agentFamilyPublishing";
import styles from "./page.module.css";

export default function SavedPrompts({ family, prompt, onSelect, disabled }) {
  const t = useTranslations("Pages.Chat.SavedPrompts");
  const panelId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [prompts, setPrompts] = useState([]);
  const [isBusy, setIsBusy] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState("");
  const requestInFlight = useRef(false);
  const isWorking = isBusy || deletingId !== null;

  async function save() {
    if (requestInFlight.current || !prompt.trim()) {
      return;
    }
    requestInFlight.current = true;
    setIsBusy(true);
    setError(null);
    setStatus("");
    try {
      const response = await fetch("/api/chat/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ family, content: prompt }),
      });
      const payload = await parseApiResponseBody(response);
      if (!response.ok) {
        throw new Error(payload?.error || t("SaveFailed"));
      }
      setPrompts((current) => [payload.prompt, ...current.filter((item) => item.id !== payload.prompt.id)]);
      setStatus(t("Saved"));
    } catch (error) {
      console.error("Save prompt failed:", error);
      setError(t("SaveFailed"));
    } finally {
      requestInFlight.current = false;
      setIsBusy(false);
    }
  }

  async function togglePicker() {
    if (requestInFlight.current) {
      return;
    }
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    requestInFlight.current = true;
    setIsOpen(true);
    setPrompts([]);
    setIsBusy(true);
    setError(null);
    setStatus("");
    try {
      const response = await fetch(`/api/chat/prompts?family=${encodeURIComponent(family)}`, { cache: "no-store" });
      const payload = await parseApiResponseBody(response);
      if (!response.ok) {
        throw new Error(payload?.error || t("LoadFailed"));
      }
      setPrompts(payload.prompts);
    } catch (error) {
      console.error("Load saved prompts failed:", error);
      setError(t("LoadFailed"));
    } finally {
      requestInFlight.current = false;
      setIsBusy(false);
    }
  }

  async function removePrompt(id) {
    if (requestInFlight.current) {
      return;
    }
    if (!window.confirm(t("ConfirmDelete"))) {
      return;
    }
    requestInFlight.current = true;
    setDeletingId(id);
    setError(null);
    setStatus("");
    try {
      const response = await fetch(`/api/chat/prompts?family=${encodeURIComponent(family)}&id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const payload = await parseApiResponseBody(response);
      if (!response.ok) {
        throw new Error(payload?.error || t("DeleteFailed"));
      }
      setPrompts((current) => current.filter((item) => item.id !== id));
      setStatus(t("Deleted"));
    } catch (error) {
      console.error("Delete saved prompt failed:", error);
      setError(t("DeleteFailed"));
    } finally {
      requestInFlight.current = false;
      setDeletingId(null);
    }
  }

  return (
    <>
      <div className={styles.composerCommands}>
        <button type="button" className="appIconButton appCompactActionButton appCompactActionButtonNeutral" title={t("Browse")} aria-label={t("Browse")} aria-expanded={isOpen} aria-controls={panelId} disabled={disabled || isWorking} onClick={togglePicker}>
          <MessageSquareMore size={20} aria-hidden="true" />
        </button>
        <button type="button" className="appIconButton appCompactActionButton appCompactActionButtonNeutral" title={t("Save")} aria-label={t("Save")} disabled={disabled || isWorking || !prompt.trim()} onClick={save}>
          <MessageSquarePlus size={20} aria-hidden="true" />
        </button>
      </div>
      {status ? <p role="status" className={styles.promptFeedback}>{status}</p> : null}
      {error ? <p role="alert" className={`${styles.promptFeedback} ${styles.errorMessage}`}>{error}</p> : null}
      {isOpen ? (
        <section id={panelId} aria-label={t("Browse")} className={styles.savedPromptPanel}>
          {isBusy ? <p role="status">{t("Loading")}</p> : !error && prompts.length === 0 ? <p>{t("Empty")}</p> : null}
          {!isBusy ? (
            <div className={styles.savedPromptList}>
              {prompts.map((item) => (
                <div key={item.id} className={styles.savedPromptRow}>
                <button type="button" className={styles.savedPromptItem} disabled={disabled || isWorking} onClick={() => {
                  onSelect(item.content);
                  setIsOpen(false);
                  setStatus("");
                }}>
                  {item.content}
                </button>
                <button type="button" className="appIconButton appCompactActionButton appCompactActionButtonNeutral" title={t("Delete")} aria-label={t("DeleteNamed", { name: item.id })} aria-busy={deletingId === item.id} disabled={disabled || isWorking} onClick={() => removePrompt(item.id)}>
                  <Trash size={20} aria-hidden="true" />
                </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
