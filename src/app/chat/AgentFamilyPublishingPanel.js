import styles from "./page.module.css";
import {
  buildFamilyActivationLabel,
  buildFamilyActionConfirmationMessage,
  buildFamilyPublishLabel,
  formatFamilyLastPublished,
  formatFamilyActionMessage,
  formatFamilyPromptAgentStatus,
  getFamilyDefinedTools,
  getFamilyStatusClassName,
  shouldDisableFamilyActivation,
  shouldShowFamilyUnpublish,
} from "./agentFamilyPublishing";

export function AgentFamilyPublishingPanel({
  agentFamilies,
  isLoading,
  statusMessage,
  errorMessage,
  pendingItems,
  onAction,
}) {
  return (
    <section className={`appPanelShell ${styles.agentManagementPanel}`}>
      <div className={`appPanelTopBar ${styles.panelHeader}`}>
        <div>
          <p className="appEyebrow">Agent Family Publishing</p>
        </div>
      </div>
      <div className={styles.agentManagementBody}>
        <p className={styles.agentManagementIntro}>
          View registered agent families and publish or re-publish Azure prompt agents for supported families.
        </p>

        {statusMessage ? <p className={styles.agentManagementStatus}>{statusMessage}</p> : null}
        {errorMessage ? <p className={styles.agentManagementError}>{errorMessage}</p> : null}

        {isLoading ? (
          <div className={`${styles.emptyState} ${styles.emptyStateCompact}`}>
            <h3>Loading agent families</h3>
            <p>Checking prompt agent publishing status for the registered families.</p>
          </div>
        ) : agentFamilies.length === 0 ? (
          <div className={`${styles.emptyState} ${styles.emptyStateCompact}`}>
            <h3>No families available</h3>
            <p>No agent families were returned for management.</p>
          </div>
        ) : (
          <div className={styles.agentFamilyList}>
            {agentFamilies.map((family) => {
              const publishPendingKey = `publish:${family.family}`;
              const activationAction = family?.isActive ? "deactivate" : "activate";
              const activationPendingKey = `${activationAction}:${family.family}`;
              const unpublishPendingKey = `unpublish:${family.family}`;
              const isPublishing = Boolean(pendingItems[publishPendingKey]);
              const isActivationPending = Boolean(pendingItems[activationPendingKey]);
              const isUnpublishing = Boolean(pendingItems[unpublishPendingKey]);
              const isPending = isPublishing || isActivationPending || isUnpublishing;
              const definedTools = getFamilyDefinedTools(family);

              return (
                <article key={family.family} className={styles.agentFamilyCard}>
                  <div className={styles.agentFamilyHeader}>
                    <div className={styles.agentFamilyHeading}>
                      <h3 className={styles.agentFamilyTitle}>{family.label || family.family}</h3>
                      {family.description ? <p className={styles.agentFamilyDescription}>{family.description}</p> : null}
                    </div>
                    <span className={`${styles.agentFamilyStatusBadge} ${getFamilyStatusClassName(styles, family)}`}>
                      {formatFamilyPromptAgentStatus(family)}
                    </span>
                  </div>

                  <div className={styles.agentFamilyMetaList}>
                    <p className={styles.agentFamilyMetaItem}>
                      <span className={styles.agentFamilyMetaLabel}>Family</span>
                      <span className={styles.agentFamilyMetaValue}>{family.family}</span>
                    </p>
                    <p className={styles.agentFamilyMetaItem}>
                      <span className={styles.agentFamilyMetaLabel}>Active</span>
                      <span className={styles.agentFamilyMetaValue}>{family.isActive ? "Yes" : "No"}</span>
                    </p>
                    <p className={styles.agentFamilyMetaItem}>
                      <span className={styles.agentFamilyMetaLabel}>Prompt agent</span>
                      <span className={styles.agentFamilyMetaValue}>{family.promptAgentName || "Not set"}</span>
                    </p>
                    <p className={styles.agentFamilyMetaItem}>
                      <span className={styles.agentFamilyMetaLabel}>Last published</span>
                      <span className={styles.agentFamilyMetaValue}>{formatFamilyLastPublished(family)}</span>
                    </p>
                    <p className={styles.agentFamilyMetaItem}>
                      <span className={styles.agentFamilyMetaLabel}>Prompt agent publishing</span>
                      <span className={styles.agentFamilyMetaValue}>{family.supportsPromptAgentPublishing ? "Supported" : "Not supported yet"}</span>
                    </p>
                  </div>

                  <div className={styles.agentFamilyMetaItemStack}>
                    <div className={styles.agentFamilyMetaItem}>
                      <span className={styles.agentFamilyMetaLabel}>Defined tools</span>
                      <span className={styles.agentFamilyMetaValue}>{definedTools.length}</span>
                    </div>

                    {definedTools.length > 0 ? (
                      <div className={styles.agentFamilyToolsList}>
                        {definedTools.map((tool) => (
                          <article
                            key={`${family.family}-${tool.name || tool.description}`}
                            className={styles.agentFamilyToolCard}
                          >
                            <div className={styles.agentFamilyToolHeader}>
                              <p className={styles.agentFamilyToolName}>{tool.name || "Unnamed tool"}</p>
                              {tool.sourceLabel ? (
                                <span className={styles.agentFamilyToolSource}>{tool.sourceLabel}</span>
                              ) : null}
                            </div>
                            {tool.description ? (
                              <p className={styles.agentFamilyToolDescription}>{tool.description}</p>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className={styles.agentFamilyToolsEmpty}>No tool definitions are available for this family.</p>
                    )}
                  </div>

                  {family.activeStateReason ? <p className={styles.agentFamilyRowError}>{family.activeStateReason}</p> : null}
                  {family.statusError ? <p className={styles.agentFamilyRowError}>{family.statusError}</p> : null}

                  <div className={styles.agentFamilyActions}>
                    {family.supportsPromptAgentPublishing ? (
                      <>
                        <button
                          type="button"
                          className="appCompactActionButton appCompactActionButtonNeutral"
                          onClick={() => onAction(family, "publish", buildFamilyActionConfirmationMessage(family, "publish"), formatFamilyActionMessage)}
                          disabled={isPending || isLoading}
                        >
                          {isPublishing ? "Publishing..." : buildFamilyPublishLabel(family)}
                        </button>
                        <button
                          type="button"
                          className="appCompactActionButton appCompactActionButtonNeutral"
                          onClick={() => onAction(family, activationAction, buildFamilyActionConfirmationMessage(family, activationAction), formatFamilyActionMessage)}
                          disabled={isPending || isLoading || shouldDisableFamilyActivation(family)}
                        >
                          {isActivationPending ? `${buildFamilyActivationLabel(family)}...` : buildFamilyActivationLabel(family)}
                        </button>
                        {shouldShowFamilyUnpublish(family) ? (
                          <button
                            type="button"
                            className="appCompactActionButton appCompactActionButtonNeutral"
                            onClick={() => onAction(family, "unpublish", buildFamilyActionConfirmationMessage(family, "unpublish"), formatFamilyActionMessage)}
                            disabled={isPending || isLoading}
                          >
                            {isUnpublishing ? "Unpublishing..." : "Unpublish"}
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <span className={styles.agentFamilyUnsupportedNote}>Prompt agent publishing is not supported for this family yet.</span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}