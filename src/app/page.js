"use client";
import Link from "next/link";
import { useEffect, useState } from 'react';
import styles from './page.module.css';

const DEFAULT_STATUS = {
  level: 'neutral',
  message: '',
};

async function callHelloNextApi(name) {
  try {
    const response = await fetch(`/api/hello?name=${encodeURIComponent(name)}`);
    const data = await response.json();

    if (!response.ok) {
      return {
        level: 'error',
        message: String(data?.message || 'Application status check failed.'),
      };
    }

    return {
      level: String(data?.level || 'neutral'),
      message: String(data?.message || ''),
    };
  } catch (err) {
    console.error('API error:', err);
    return {
      level: 'error',
      message: 'Application status: failed.',
    };
  }
}

export default function Home() {
  const [applicationStatus, setApplicationStatus] = useState(DEFAULT_STATUS);

  useEffect(() => {
    callHelloNextApi('from nextapi').then(result => {
      setApplicationStatus(result);
    });
  }, []);

  return (
    <main className={`${styles.pageShell} appPageShell`}>
      <section className={styles.heroCard}>
        <div className="appHeroCopy">
          <p className="appEyebrow">Material. Domain. Speak.</p>
          <h1 className={`${styles.title} appPageTitle`}>
            Grow a tree of knowledge.
            <br />
            Start talking to it.
          </h1>
        </div>
        <div className={styles.statusRow}>
          <div className={styles.statusCard}>
            <p className={styles.statusLabel}>Primary workflow</p>
            <p className={styles.statusValue}>Notes grow the tree. Search inspects the material. Agent talks from a domain — and shows how the answer is grounded.</p>
          </div>
          <div className={styles.statusCard}>
            <p className={styles.statusLabel}>System status</p>
            <p className={`${styles.statusValue} ${styles[`statusValue${applicationStatus.level.charAt(0).toUpperCase()}${applicationStatus.level.slice(1)}`] || ''}`.trim()}>
              {applicationStatus.message || 'Checking...'}
            </p>
          </div>
        </div>
      </section>

      <section className={styles.routeGrid}>
        <article className={styles.routeCard}>
          <p className={styles.cardEyebrow}>Notes</p>
          <h2 className={styles.cardTitle}>Grow the tree</h2>
          <p className={styles.cardDescription}>Create or generate trees, branches, and leaves — notes and attachments live on the leaves. The structure and the material together power search and chat.</p>
          <Link href="/notes" className={styles.cardLink}>Open Notes</Link>
        </article>

        <article className={styles.routeCard}>
          <p className={styles.cardEyebrow}>Search</p>
          <h2 className={styles.cardTitle}>Inspect the material</h2>
          <p className={styles.cardDescription}>Look through notes and attachments, see the highlights, and jump to the branch and leaf they came from.</p>
          <Link href="/search" className={styles.cardLink}>Open Search</Link>
        </article>

        <article className={styles.routeCard}>
          <p className={styles.cardEyebrow}>Agent</p>
          <h2 className={styles.cardTitle}>Talk to the tree</h2>
          <p className={styles.cardDescription}>Ask a domain and get an answer drawn from its notes and material — with the evidence attached.</p>
          <Link href="/chat" className={styles.cardLink}>Open Agent</Link>
        </article>
      </section>
    </main>
  );
}
