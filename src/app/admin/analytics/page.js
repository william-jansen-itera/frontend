"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import styles from "../page.module.css";
import { formatTimestamp, formatVisitCount, getErrorMessage } from "../adminShared";

export default function AdminAnalyticsPage() {
  const t = useTranslations("Pages.Admin.Analytics");
  const [analyticsSummary, setAnalyticsSummary] = useState({ byPageDeviceBrowser: [], byPage: [], byPageSource: [], generatedAt: null });
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  const loadAnalyticsSummary = async ({ showLoadingState = true } = {}) => {
    if (showLoadingState) {
      setIsLoading(true);
    }

    try {
      const response = await fetch("/api/admin/analytics", { cache: "no-store" });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Analytics could not be loaded");
      }

      setAnalyticsSummary({
        byPageDeviceBrowser: Array.isArray(data?.byPageDeviceBrowser) ? data.byPageDeviceBrowser : [],
        byPage: Array.isArray(data?.byPage) ? data.byPage : [],
        byPageSource: Array.isArray(data?.byPageSource) ? data.byPageSource : [],
        generatedAt: data?.generatedAt || null,
      });
      setErrorMessage("");
    } catch (error) {
      setAnalyticsSummary({ byPageDeviceBrowser: [], byPage: [], byPageSource: [], generatedAt: null });
      setErrorMessage(getErrorMessage(error, "Analytics could not be loaded"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    Promise.resolve().then(async () => {
      await loadAnalyticsSummary({ showLoadingState: false });
    });
  }, []);

  return (
    <>
      <section className={`appTopLevelPanel ${styles.heroCard}`}>
        <div className={styles.heroHeader}>
          <div className="appHeroCopy">
            <p className="appEyebrow">{t("Title")}</p>
            <h2 className="appPageTitle">{t("Heading")}</h2>
            <div className={styles.heroDescriptionStack}>
              <p className="appPageDescription">{t("Intro")}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={loadAnalyticsSummary}
            disabled={isLoading}
            className="appPrimaryFormButton"
          >
            {t(isLoading ? "Refreshing" : "Refresh")}
          </button>
        </div>
        {analyticsSummary.generatedAt ? (
          <p className={styles.tableMeta}>{t("LastAggregated", { date: formatTimestamp(analyticsSummary.generatedAt) })}</p>
        ) : null}
        {errorMessage ? <p className={styles.errorMessage}>{errorMessage}</p> : null}
      </section>

      <section className={styles.sectionStack}>
        <article className={`appTopLevelPanel ${styles.panel}`}>
          <div className={styles.panelBody}>
            {isLoading ? (
              <div className={styles.emptyState}>{t("Loading")}</div>
            ) : (
              <div className={styles.analyticsTables}>
                <section className={styles.analyticsSection}>
                  <h2 className={styles.analyticsHeading}>{t("ByDevice")}</h2>
                  <div className={styles.indexingTableWrapper}>
                    <table className={styles.indexingTable}>
                      <thead>
                        <tr>
                          <th scope="col" className={styles.indexingColumnHeader}>{t("Path")}</th>
                          <th scope="col" className={styles.indexingColumnHeader}>{t("Device")}</th>
                          <th scope="col" className={styles.indexingColumnHeader}>{t("Browser")}</th>
                          <th scope="col" className={styles.indexingColumnHeader}>{t("Visits")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analyticsSummary.byPageDeviceBrowser.length === 0 ? (
                          <tr>
                            <td colSpan={4} className={styles.analyticsEmptyCell}>{t("Empty")}</td>
                          </tr>
                        ) : analyticsSummary.byPageDeviceBrowser.map((row) => (
                          <tr key={`${row.pagePath}:${row.deviceClass}:${row.browserFamily}`}>
                            <td>{row.pagePath}</td>
                            <td>{row.deviceClass}</td>
                            <td>{row.browserFamily}</td>
                            <td>{formatVisitCount(row.visitCount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className={styles.analyticsSection}>
                  <h2 className={styles.analyticsHeading}>{t("ByPage")}</h2>
                  <div className={styles.indexingTableWrapper}>
                    <table className={styles.indexingTable}>
                      <thead>
                        <tr>
                          <th scope="col" className={styles.indexingColumnHeader}>{t("Path")}</th>
                          <th scope="col" className={styles.indexingColumnHeader}>{t("Visits")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analyticsSummary.byPage.length === 0 ? (
                          <tr>
                            <td colSpan={2} className={styles.analyticsEmptyCell}>{t("Empty")}</td>
                          </tr>
                        ) : analyticsSummary.byPage.map((row) => (
                          <tr key={row.pagePath}>
                            <td>{row.pagePath}</td>
                            <td>{formatVisitCount(row.visitCount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className={styles.analyticsSection}>
                  <h2 className={styles.analyticsHeading}>{t("BySource")}</h2>
                  <div className={styles.indexingTableWrapper}>
                    <table className={styles.indexingTable}>
                      <thead>
                        <tr>
                          <th scope="col" className={styles.indexingColumnHeader}>{t("Path")}</th>
                          <th scope="col" className={styles.indexingColumnHeader}>{t("Source")}</th>
                          <th scope="col" className={styles.indexingColumnHeader}>{t("Visits")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analyticsSummary.byPageSource.length === 0 ? (
                          <tr>
                            <td colSpan={3} className={styles.analyticsEmptyCell}>{t("EmptySource")}</td>
                          </tr>
                        ) : analyticsSummary.byPageSource.map((row) => (
                          <tr key={`${row.pagePath}:${row.source}`}>
                            <td>{row.pagePath}</td>
                            <td>{row.source}</td>
                            <td>{formatVisitCount(row.visitCount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}
          </div>
        </article>
      </section>
    </>
  );
}