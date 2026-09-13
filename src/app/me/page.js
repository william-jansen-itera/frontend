"use client";

import styles from "./page.module.css";
import { useAuth } from "../useAuth";

function formatValue(value, fallback = "Not available") {
  const normalizedValue = String(value ?? "").trim();
  return normalizedValue || fallback;
}

export default function MePage() {
  const { user, signIn, isAuthResolved } = useAuth();

  if (!isAuthResolved) {
    return (
      <main className="appPageShell">
        <section className={styles.heroCard}>
          <div className="appHeroCopy">
            <p className="appEyebrow">Me</p>
            <h1 className={`${styles.title} appPageTitle`}>Loading your profile.</h1>
            <p className="appPageDescription">Fetching the current authenticated principal.</p>
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
            <p className="appEyebrow">Me</p>
            <h1 className={`${styles.title} appPageTitle`}>You are not signed in.</h1>
            <p className="appPageDescription">Sign in to inspect your basic identity details and current roles.</p>
            <div className={styles.actionRow}>
              <button type="button" onClick={signIn} className="appPrimaryFormButton">Sign In</button>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const profileFields = [
    { label: "Display name", value: formatValue(user.displayName || user.userDetails) },
    { label: "User details", value: formatValue(user.userDetails), isMonospace: true },
    { label: "Object ID", value: formatValue(user.objectId), isMonospace: true },
    { label: "Roles", value: Array.isArray(user.userRoles) && user.userRoles.length > 0 ? user.userRoles.join(", ") : "No roles assigned" },
  ];

  return (
    <main className="appPageShell">
      <section className={styles.heroCard}>
        <div className="appHeroCopy">
          <p className="appEyebrow">Me</p>
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