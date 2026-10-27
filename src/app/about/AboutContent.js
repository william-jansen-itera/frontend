"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import PageVisitTracker from "../PageVisitTracker";
import styles from "./page.module.css";

const SECTIONS = [
  "Grow", "Generate", "Extend", "StartFromTree", "Review", "Inspect", "Talk",
  "Ground", "Broader", "Capture", "Memory", "Restore", "Access",
];

export default function AboutContent() {
  const t = useTranslations("Pages.About");

  return (
    <main className="appPageShell">
      <PageVisitTracker pagePath="/about" />
      <section className={styles.heroCard}>
        <div className="appHeroCopy">
          <p className="appEyebrow">{t("Title")}</p>
          <h1 className={`${styles.title} appPageTitle`}>{t("Headline")}</h1>
          <p className="appPageDescription">{t("Intro")}</p>
          <blockquote className={styles.heroQuote}>
            <p className={styles.heroQuoteText}>{t("Quote")}</p>
            <footer className={styles.heroQuoteAttribution}>William Jansen</footer>
          </blockquote>
        </div>
      </section>

      <section className={styles.contentGrid}>
        {SECTIONS.map((section) => (
          <article key={section} className={styles.infoCard}>
            <p className={styles.cardEyebrow}>{t(`${section}.Label`)}</p>
            <h2 className={styles.cardTitle}>{t(`${section}.Title`)}</h2>
            <p className={styles.cardText}>{t(`${section}.Text`)}</p>
          </article>
        ))}
      </section>

      <section className={styles.ctaCard}>
        <div><p className={styles.cardEyebrow}>{t("WorkingSurfaces")}</p></div>
        <div className={styles.ctaLinks}>
          <Link href="/notes" prefetch={false} className={styles.ctaLink}>{t("OpenNotes")}</Link>
          <Link href="/search" prefetch={false} className={styles.ctaLinkSecondary}>{t("OpenSearch")}</Link>
          <Link href="/chat" prefetch={false} className={styles.ctaLinkSecondary}>{t("OpenAgent")}</Link>
          <Link href="/contact" prefetch={false} className={styles.ctaLinkSecondary}>{t("Contact")}</Link>
        </div>
      </section>
    </main>
  );
}