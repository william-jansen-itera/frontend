"use client";

import { useAuth } from "@/app/useAuth";
import { hasClientPrincipalRole } from "@/shared/clientPrincipal";
import styles from "./page.module.css";

export default function AdminLayout({ children }) {
  const { user } = useAuth();
  const isAdmin = hasClientPrincipalRole(user, "mdsadmins");

  if (!user) {
    return (
      <main className={`${styles.pageShell} appPageShell`}>
        <section className={`appTopLevelPanel ${styles.heroCard}`}>
          <p className="appEyebrow">Admin</p>
          <h1 className="appPageTitle">Admin operations</h1>
          <p className="appPageDescription">Sign in with a user that has the mdsadmins role to manage admin workflows.</p>
        </section>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className={`${styles.pageShell} appPageShell`}>
        <section className={`appTopLevelPanel ${styles.heroCard}`}>
          <p className="appEyebrow">Admin</p>
          <h1 className="appPageTitle">Admin operations</h1>
          <p className="appPageDescription">This section requires the mdsadmins role.</p>
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