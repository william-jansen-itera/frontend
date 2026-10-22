"use client";
import PageVisitTracker from './PageVisitTracker';
import Link from "next/link";
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from './useAuth';
import styles from './page.module.css';

const DEFAULT_STATUS = {
  level: 'neutral',
  message: '',
};

function tryParseJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callHelloNextApi(name) {
  try {
    const response = await fetch(`/api/hello?name=${encodeURIComponent(name)}`);
    const responseText = await response.text();
    const data = tryParseJson(responseText);

    if (!response.ok) {
      return {
        level: 'error',
        message: String(data?.message || 'Application status check failed.'),
      };
    }

    if (!data) {
      return {
        level: 'error',
        message: 'Application status check returned an unexpected response.',
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
  const t = useTranslations('Pages.Home');
  const { user, isAuthResolved } = useAuth();
  const [applicationStatus, setApplicationStatus] = useState(DEFAULT_STATUS);
  const isSignedIn = Boolean(user);

  useEffect(() => {
    if (!isAuthResolved || !isSignedIn) {
      return;
    }

    callHelloNextApi('from nextapi').then(result => {
      setApplicationStatus(result);
    });
  }, [isAuthResolved, isSignedIn]);

  return (
    <main className={`${styles.pageShell} appPageShell`}>
      <PageVisitTracker pagePath="/" />
      <section className={styles.heroCard}>
        <div className="appHeroCopy">
          <p className="appEyebrow">{t('Eyebrow')}</p>
          <h1 className={`${styles.title} appPageTitle`}>
            {t('HeroLineOne')}
            <br />
            {t('HeroLineTwo')}
          </h1>
        </div>
        <div className={styles.statusRow}>
          <div className={styles.statusCard}>
            <p className={styles.statusLabel}>{t('HowItWorks')}</p>
            <p className={styles.statusValue}>
              {t('Overview')}{' '}
              <Link href="/about" prefetch={false} className={styles.inlineLink}>{t('ReadMore')}</Link>
            </p>
          </div>
          {isSignedIn ? (
            <div className={styles.statusCard}>
              <p className={styles.statusLabel}>{t('ServiceStatus')}</p>
              <p className={`${styles.statusValue} ${styles[`statusValue${applicationStatus.level.charAt(0).toUpperCase()}${applicationStatus.level.slice(1)}`] || ''}`.trim()}>
                {applicationStatus.message || t('Checking')}
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <section className={styles.routeGrid}>
        <article className={styles.routeCard}>
          <p className={styles.cardEyebrow}>{t('Notes.Name')}</p>
          <h2 className={styles.cardTitle}>{t('Notes.Title')}</h2>
          <p className={styles.cardDescription}>{t('Notes.Description')}</p>
          <Link href="/notes" prefetch={false} className={styles.cardLink}>{t('Notes.Open')}</Link>
        </article>

        <article className={styles.routeCard}>
          <p className={styles.cardEyebrow}>{t('Search.Name')}</p>
          <h2 className={styles.cardTitle}>{t('Search.Title')}</h2>
          <p className={styles.cardDescription}>{t('Search.Description')}</p>
          <Link href="/search" prefetch={false} className={styles.cardLink}>{t('Search.Open')}</Link>
        </article>

        <article className={styles.routeCard}>
          <p className={styles.cardEyebrow}>{t('Agent.Name')}</p>
          <h2 className={styles.cardTitle}>{t('Agent.Title')}</h2>
          <p className={styles.cardDescription}>{t('Agent.Description')}</p>
          <Link href="/chat" prefetch={false} className={styles.cardLink}>{t('Agent.Open')}</Link>
        </article>
      </section>
    </main>
  );
}
