import { useTranslations } from "next-intl";
import styles from "../page.module.css";
import {
  formatFamilyActionMessage,
  formatFamilyLastPublished,
  formatFamilyPromptAgentStatus,
  getFamilyDefinedTools,
  getFamilyStatusClassName,
  shouldDisableFamilyActivation,
  shouldShowFamilyUnpublish,
} from "./agentFamilyPublishing";

const STATUS_KEYS = {
  Active: "Active", Deactivated: "Deactivated", Unpublished: "Unpublished",
  "Not published": "NotPublished", Publishing: "Publishing", Unsupported: "Unsupported",
  "Status error": "StatusError", Unknown: "Unknown",
};

export function AgentFamilyPublishingPanel({
  agentFamilies,
  isLoading,
  statusMessage,
  errorMessage,
  pendingItems,
  onAction,
}) {
  const t = useTranslations("Pages.Admin.Publishing");

  return (
    <section className={`appTopLevelPanel ${styles.panel}`}>
      <div className={styles.panelBody}>
        <p className={styles.sectionDescription}>
          {t("Description")}
        </p>

        {statusMessage ? <p className={styles.agentManagementStatus}>{statusMessage}</p> : null}
        {errorMessage ? <p className={styles.agentManagementError}>{errorMessage}</p> : null}

        {isLoading ? (
          <div className={`${styles.emptyState} ${styles.emptyStateCompact}`}>
            <h3>{t("Loading")}</h3>
            <p>{t("LoadingHint")}</p>
          </div>
        ) : agentFamilies.length === 0 ? (
          <div className={`${styles.emptyState} ${styles.emptyStateCompact}`}>
            <h3>{t("Empty")}</h3>
            <p>{t("EmptyHint")}</p>
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
              const familyName = family.label || family.family;
              const publishAction = family.promptAgentStatus === "published" ? "Republish" : "Publish";
              const publishedAt = formatFamilyLastPublished(family);

              return (
                <article key={family.family} className={styles.agentFamilyCard}>
                  <div className={styles.agentFamilyHeader}>
                    <div className={styles.agentFamilyHeading}>
                      <h3 className={styles.agentFamilyTitle}>{family.label || family.family}</h3>
                      {family.description ? <p className={styles.agentFamilyDescription}>{family.description}</p> : null}
                    </div>
                    <span className={`${styles.agentFamilyStatusBadge} ${getFamilyStatusClassName(styles, family)}`}>
                      {t(`Statuses.${STATUS_KEYS[formatFamilyPromptAgentStatus(family)] ?? "Unknown"}`)}
                    </span>
                  </div>

                  <div className={styles.agentFamilyMetaList}>
                    <p className={styles.agentFamilyMetaItem}>
                      <span className={styles.agentFamilyMetaLabel}>{t("Family")}</span>
                      <span className={styles.agentFamilyMetaValue}>{family.family}</span>
                    </p>
                    <p className={styles.agentFamilyMetaItem}>
                      <span className={styles.agentFamilyMetaLabel}>{t("Active")}</span>
                      <span className={styles.agentFamilyMetaValue}>{t(family.isActive ? "Yes" : "No")}</span>
                    </p>
                    <p className={styles.agentFamilyMetaItem}>
                      <span className={styles.agentFamilyMetaLabel}>{t("PromptAgent")}</span>
                      <span className={styles.agentFamilyMetaValue}>{family.promptAgentName || t("NotSet")}</span>
                    </p>
                    <p className={styles.agentFamilyMetaItem}>
                      <span className={styles.agentFamilyMetaLabel}>{t("LastPublished")}</span>
                      <span className={styles.agentFamilyMetaValue}>{["Never", "Not applicable", "Unavailable", "Unknown"].includes(publishedAt) ? t(publishedAt === "Not applicable" ? "NotApplicable" : publishedAt === "Unknown" ? "Statuses.Unknown" : publishedAt) : publishedAt}</span>
                    </p>
                    <p className={styles.agentFamilyMetaItem}>
                      <span className={styles.agentFamilyMetaLabel}>{t("PublishingSupport")}</span>
                      <span className={styles.agentFamilyMetaValue}>{t(family.supportsPromptAgentPublishing ? "Supported" : "NotSupported")}</span>
                    </p>
                  </div>

                  <div className={styles.agentFamilyMetaItemStack}>
                    <div className={styles.agentFamilyMetaItem}>
                      <span className={styles.agentFamilyMetaLabel}>{t("DefinedTools")}</span>
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
                              <p className={styles.agentFamilyToolName}>{tool.name || t("UnnamedTool")}</p>
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
                      <p className={styles.agentFamilyToolsEmpty}>{t("NoTools")}</p>
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
                          onClick={() => onAction(family, "publish", t("ConfirmPublish", { action: t(publishAction).toLowerCase(), name: familyName }), formatFamilyActionMessage)}
                          disabled={isPending || isLoading}
                        >
                          {t(isPublishing ? "Publishing" : publishAction)}
                        </button>
                        <button
                          type="button"
                          className="appCompactActionButton appCompactActionButtonNeutral"
                          onClick={() => onAction(family, activationAction, t(family.isActive ? "ConfirmDeactivate" : "ConfirmActivate", { name: familyName }), formatFamilyActionMessage)}
                          disabled={isPending || isLoading || shouldDisableFamilyActivation(family)}
                        >
                          {t(family.isActive ? isActivationPending ? "Deactivating" : "Deactivate" : isActivationPending ? "Activating" : "Activate")}
                        </button>
                        {shouldShowFamilyUnpublish(family) ? (
                          <button
                            type="button"
                            className="appCompactActionButton appCompactActionButtonNeutral"
                            onClick={() => onAction(family, "unpublish", t("ConfirmUnpublish", { name: familyName }), formatFamilyActionMessage)}
                            disabled={isPending || isLoading}
                          >
                            {t(isUnpublishing ? "Unpublishing" : "Unpublish")}
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <span className={styles.agentFamilyUnsupportedNote}>{t("UnsupportedNote")}</span>
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