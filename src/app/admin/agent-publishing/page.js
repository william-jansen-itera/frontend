"use client";

import { useEffect, useState } from "react";
import styles from "../page.module.css";
import { AgentFamilyPublishingPanel } from "./AgentFamilyPublishingPanel";
import {
  buildFamilyActionConfirmationMessage,
  fetchAgentFamilyManagementState,
  formatFamilyActionMessage,
} from "./agentFamilyPublishing";
import { getErrorMessage } from "../adminShared";

export default function AdminAgentPublishingPage() {
  const [agentFamilies, setAgentFamilies] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [pendingItems, setPendingItems] = useState({});

  const setPending = (key, isPending) => {
    setPendingItems((currentState) => ({
      ...currentState,
      [key]: isPending,
    }));
  };

  const loadAgentFamilies = async ({ showLoadingState = true } = {}) => {
    if (showLoadingState) {
      setIsLoading(true);
    }

    try {
      const families = await fetchAgentFamilyManagementState();
      setAgentFamilies(families);
      setErrorMessage("");
    } catch (error) {
      setAgentFamilies([]);
      setErrorMessage(getErrorMessage(error, "Agent families could not be loaded"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    Promise.resolve().then(async () => {
      await loadAgentFamilies({ showLoadingState: false });
    });
  }, []);

  const handleAgentFamilyAction = async (family, action, confirmationMessage, formatMessage) => {
    const normalizedFamily = String(family?.family ?? "").trim();
    const familyLabel = String(family?.label ?? normalizedFamily).trim();

    if (!normalizedFamily) {
      return;
    }

    const confirmed = window.confirm(confirmationMessage || buildFamilyActionConfirmationMessage(family, action));

    if (!confirmed) {
      return;
    }

    const pendingKey = `${action}:${normalizedFamily}`;
    setPending(pendingKey, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/admin/agents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          family: normalizedFamily,
          action,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error || `Action ${action} could not be completed for ${familyLabel}`);
      }

      setStatusMessage((formatMessage || formatFamilyActionMessage)(family, action, payload?.operation));
      await loadAgentFamilies({ showLoadingState: false });
    } catch (error) {
      setErrorMessage(getErrorMessage(error, `Action ${action} could not be completed for ${familyLabel}`));
    } finally {
      setPending(pendingKey, false);
    }
  };

  return (
    <>
      <section className={`appTopLevelPanel ${styles.heroCard}`}>
        <div className={styles.heroHeader}>
          <div className="appHeroCopy">
            <p className="appEyebrow">Agent publishing</p>
            <h2 className="appPageTitle">Agent family operations</h2>
            <div className={styles.heroDescriptionStack}>
              <p className="appPageDescription">Manage Azure prompt agent publishing and activation for registered agent families.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => loadAgentFamilies()}
            disabled={isLoading}
            className="appPrimaryFormButton"
          >
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </section>

      <AgentFamilyPublishingPanel
        agentFamilies={agentFamilies}
        isLoading={isLoading}
        statusMessage={statusMessage}
        errorMessage={errorMessage}
        pendingItems={pendingItems}
        onAction={handleAgentFamilyAction}
      />
    </>
  );
}