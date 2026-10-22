"use client";

import styles from "./page.module.css";
import { useAuth } from "../useAuth";
import { useTranslations } from "next-intl";

function formatValue(value, fallback = "Not available") {
  const normalizedValue = String(value ?? "").trim();
  return normalizedValue || fallback;
}

export default function MePage() {
  const t = useTranslations("Pages.Me");
  const { user, signIn, isAuthResolved } = useAuth();

  if (!isAuthResolved) {
    return (
      <main className="appPageShell">
        <section className={styles.heroCard}>
          <div className="appHeroCopy">
            <p className="appEyebrow">{t("Title")}</p>
            <h1 className={`${styles.title} appPageTitle`}>{t("Loading")}</h1>
            <p className="appPageDescription">{t("Fetching")}</p>
          </div>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="appPageShell">
        <section className={styles.heroCard}>
          <div className="appHeroCopy">
            <p className="appEyebrow">{t("Title")}</p>
            <h1 className={`${styles.title} appPageTitle`}>{t("SignedOut")}</h1>
            <p className="appPageDescription">{t("SignInHint")}</p>
            <div className={styles.actionRow}>
              <button type="button" onClick={signIn} className="appPrimaryFormButton">{t("SignIn")}</button>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const profileFields = [
    { label: t("DisplayName"), value: formatValue(user.displayName || user.userDetails, t("NotAvailable")) },
    { label: t("UserDetails"), value: formatValue(user.userDetails, t("NotAvailable")), isMonospace: true },
    { label: t("ObjectId"), value: formatValue(user.objectId, t("NotAvailable")), isMonospace: true },
    { label: t("Roles"), value: Array.isArray(user.userRoles) && user.userRoles.length > 0 ? user.userRoles.join(", ") : t("NoRoles") },
  ];

  return (
    <main className="appPageShell">
      <section className={styles.heroCard}>
        <div className="appHeroCopy">
          <p className="appEyebrow">{t("Title")}</p>
          <div className={styles.fieldList}>
            {profileFields.map((field) => (
              <div key={field.label} className={styles.fieldRow}>
                <p className={styles.fieldLabel}>{field.label}</p>
                <p className={`${styles.fieldValue} ${field.isMonospace ? styles.fieldValueMonospace : ""}`.trim()}>{field.value}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}