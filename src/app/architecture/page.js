"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import styles from "../about/page.module.css";

export default function Architecture() {
  const t = useTranslations("Pages.Architecture");
  return (
    <main className="appPageShell">
      <section className={styles.heroCard}>
        <div className="appHeroCopy">
          <p className="appEyebrow">{t("Title")}</p>
          <h1 className={`${styles.title} appPageTitle`}>{t("Headline")}</h1>
          <p className="appPageDescription">
            {t("Intro")}
          </p>
        </div>
      </section>

      <section className={styles.contentGrid}>
        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("Structure.Label")}</p>
          <h2 className={styles.cardTitle}>{t("Structure.Title")}</h2>
          <p className={styles.cardText}>{t("Structure.Text")}</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("Routing.Label")}</p>
          <h2 className={styles.cardTitle}>{t("Routing.Title")}</h2>
          <p className={styles.cardText}>{t("Routing.Text")}</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("Security.Label")}</p>
          <h2 className={styles.cardTitle}>{t("Security.Title")}</h2>
          <p className={styles.cardText}>{t("Security.Text")}</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("Retrieval.Label")}</p>
          <h2 className={styles.cardTitle}>{t("Retrieval.Title")}</h2>
          <p className={styles.cardText}>{t("Retrieval.Text")}</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("Details.Label")}</p>
          <h2 className={styles.cardTitle}>{t("Details.Title")}</h2>
          <p className={styles.cardText}>{t("Details.Text")}</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("Traceability.Label")}</p>
          <h2 className={styles.cardTitle}>{t("Traceability.Title")}</h2>
          <p className={styles.cardText}>{t("Traceability.Text")}</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("Growth.Label")}</p>
          <h2 className={styles.cardTitle}>{t("Growth.Title")}</h2>
          <p className={styles.cardText}>{t("Growth.Text")}</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("Extensibility.Label")}</p>
          <h2 className={styles.cardTitle}>{t("Extensibility.Title")}</h2>
          <p className={styles.cardText}>{t("Extensibility.Text")}</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("Runtime.Label")}</p>
          <h2 className={styles.cardTitle}>{t("Runtime.Title")}</h2>
          <p className={styles.cardText}>{t("Runtime.Text")}</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("Retention.Label")}</p>
          <h2 className={styles.cardTitle}>{t("Retention.Title")}</h2>
          <p className={styles.cardText}>{t("Retention.Text")}</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("Review.Label")}</p>
          <h2 className={styles.cardTitle}>{t("Review.Title")}</h2>
          <p className={styles.cardText}>{t("Review.Text")}</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("Index.Label")}</p>
          <h2 className={styles.cardTitle}>{t("Index.Title")}</h2>
          <p className={styles.cardText}>{t("Index.Text")}</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("Access.Label")}</p>
          <h2 className={styles.cardTitle}>{t("Access.Title")}</h2>
          <p className={styles.cardText}>{t("Access.Text")}</p>
        </article>
      </section>

      <section className={styles.ctaCard}>
        <div>
          <p className={styles.cardEyebrow}>{t("WorkingSurfaces")}</p>
          <h2 className={styles.cardTitle}>{t("Continue")}</h2>
        </div>
        <div className={styles.ctaLinks}>
          <Link href="/notes" className={styles.ctaLink}>{t("OpenNotes")}</Link>
          <Link href="/search" className={styles.ctaLinkSecondary}>{t("OpenSearch")}</Link>
          <Link href="/chat" prefetch={false} className={styles.ctaLinkSecondary}>{t("OpenAgent")}</Link>
        </div>
      </section>
    </main>
  );
}