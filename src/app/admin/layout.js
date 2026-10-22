"use client";

import { useAuth } from "@/app/useAuth";
import { useTranslations } from "next-intl";
import { hasClientPrincipalRole } from "@/shared/clientPrincipal";
import styles from "./page.module.css";

export default function AdminLayout({ children }) {
  const t = useTranslations("Pages.Admin");
  const { user } = useAuth();
  const isAdmin = hasClientPrincipalRole(user, "mdsadmins");

  if (!user) {
    return (
      <main className={`${styles.pageShell} appPageShell`}>
        <section className={`appTopLevelPanel ${styles.heroCard}`}>
          <p className="appEyebrow">{t("Title")}</p>
          <h1 className="appPageTitle">{t("Operations")}</h1>
          <p className="appPageDescription">{t("SignIn")}</p>
        </section>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className={`${styles.pageShell} appPageShell`}>
        <section className={`appTopLevelPanel ${styles.heroCard}`}>
          <p className="appEyebrow">{t("Title")}</p>
          <h1 className="appPageTitle">{t("Operations")}</h1>
          <p className="appPageDescription">{t("Restricted")}</p>
        </section>
      </main>
    );
  }

  return (
    <main className={`${styles.pageShell} appPageShell`}>
      {children}
    </main>
  );
}