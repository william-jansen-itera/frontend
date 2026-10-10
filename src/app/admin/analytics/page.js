"use client";

import { useEffect, useState } from "react";
import styles from "../page.module.css";
import { formatTimestamp, formatVisitCount, getErrorMessage } from "../adminShared";

export default function AdminAnalyticsPage() {
  const [analyticsSummary, setAnalyticsSummary] = useState({ byPageDeviceBrowser: [], byPage: [], generatedAt: null });
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
        generatedAt: data?.generatedAt || null,
      });
      setErrorMessage("");
    } catch (error) {
      setAnalyticsSummary({ byPageDeviceBrowser: [], byPage: [], generatedAt: null });
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
            <p className="appEyebrow">Analytics</p>
            <h2 className="appPageTitle">Page visit aggregates</h2>
            <div className={styles.heroDescriptionStack}>
              <p className="appPageDescription">Live aggregates from the append-only visit event log.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={loadAnalyticsSummary}
            disabled={isLoading}
            className="appPrimaryFormButton"
          >
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        {analyticsSummary.generatedAt ? (
          <p className={styles.tableMeta}>Last aggregated: {formatTimestamp(analyticsSummary.generatedAt)}</p>
        ) : null}
        {errorMessage ? <p className={styles.errorMessage}>{errorMessage}</p> : null}
      </section>

      <article className={`appTopLevelPanel ${styles.panel}`}>
        <div className={styles.panelBody}>
          {isLoading ? (
            <div className={styles.emptyState}>Loading analytics...</div>
          ) : (
            <div className={styles.analyticsTables}>
              <section className={styles.analyticsSection}>
                <h2 className={styles.analyticsHeading}>By page, device class, and browser family</h2>
                <div className={styles.indexingTableWrapper}>
                  <table className={styles.indexingTable}>
                    <thead>
                      <tr>
                        <th scope="col" className={styles.indexingColumnHeader}>page path</th>
                        <th scope="col" className={styles.indexingColumnHeader}>device class</th>
                        <th scope="col" className={styles.indexingColumnHeader}>browser family</th>
                        <th scope="col" className={styles.indexingColumnHeader}>visits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analyticsSummary.byPageDeviceBrowser.length === 0 ? (
                        <tr>
                          <td colSpan={4} className={styles.analyticsEmptyCell}>No visit events recorded yet.</td>
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
                <h2 className={styles.analyticsHeading}>By page</h2>
                <div className={styles.indexingTableWrapper}>
                  <table className={styles.indexingTable}>
                    <thead>
                      <tr>
                        <th scope="col" className={styles.indexingColumnHeader}>page path</th>
                        <th scope="col" className={styles.indexingColumnHeader}>visits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analyticsSummary.byPage.length === 0 ? (
                        <tr>
                          <td colSpan={2} className={styles.analyticsEmptyCell}>No visit events recorded yet.</td>
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
            </div>
          )}
        </div>
      </article>
    </>
  );
}