"use client";
import Link from "next/link";
import { useEffect, useState } from 'react';
import styles from './page.module.css';


async function callHelloNextApi(name) {
  try {
    const response = await fetch(`/api/hello?name=${encodeURIComponent(name)}`);
    const data = await response.text();
    return data;
  } catch (err) {
    console.error('API error:', err);
    return 'Error calling next API';
  }
}

export default function Home() {
  const [nextApiResult, setNextApiResult] = useState('');

  useEffect(() => {
    callHelloNextApi('from nextapi').then(result => {
      setNextApiResult(result);
    });
  }, []);

  return (
    <main className={styles.pageShell}>
      <section className={styles.heroCard}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Knowledge App</p>
          <h1 className={styles.title}>Work with trees, notes, search, and grounded answers in one place.</h1>
          <p className={styles.description}>
            Use Notes to curate the tree structure, Search to inspect indexed content, and Ask to see how the agent grounds an answer in the underlying material.
          </p>
        </div>

        <div className={styles.statusRow}>
          <div className={styles.statusCard}>
            <p className={styles.statusLabel}>Next API status</p>
            <p className={styles.statusValue}>{nextApiResult || 'Checking...'}</p>
          </div>
          <div className={styles.statusCard}>
            <p className={styles.statusLabel}>Primary workflow</p>
            <p className={styles.statusValue}>Curate in Notes, validate in Search, answer in Ask.</p>
          </div>
        </div>
      </section>

      <section className={styles.routeGrid}>
        <article className={styles.routeCard}>
          <p className={styles.cardEyebrow}>Notes</p>
          <h2 className={styles.cardTitle}>Manage the source structure</h2>
          <p className={styles.cardDescription}>Navigate trees, edit leaf details, and attach supporting material directly to the nodes that power search and chat.</p>
          <Link href="/notes" className={styles.cardLink}>Open Notes</Link>
        </article>

        <article className={styles.routeCard}>
          <p className={styles.cardEyebrow}>Search</p>
          <h2 className={styles.cardTitle}>Inspect indexed evidence</h2>
          <p className={styles.cardDescription}>Search across notes and attachments, review highlights, and jump into the exact node path that produced a match.</p>
          <Link href="/search" className={styles.cardLink}>Open Search</Link>
        </article>

        <article className={styles.routeCard}>
          <p className={styles.cardEyebrow}>Ask</p>
          <h2 className={styles.cardTitle}>Trace grounded responses</h2>
          <p className={styles.cardDescription}>Send a question to the agent and inspect tool calls, curated input, and the final model response side by side.</p>
          <Link href="/chat" className={styles.cardLink}>Open Ask</Link>
        </article>
      </section>
    </main>
  );
}
