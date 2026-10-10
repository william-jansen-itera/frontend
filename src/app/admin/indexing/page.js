"use client";

import { useState } from "react";
import styles from "../page.module.css";
import {
  formatIndexingErrorMessage,
  formatIndexingResultMessage,
  getErrorMessage,
  INDEXING_COLUMNS,
  INDEXING_ROWS,
} from "../adminShared";

export default function AdminIndexingPage() {
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [pendingItems, setPendingItems] = useState({});

  const setPending = (key, isPending) => {
    setPendingItems((current) => ({
      ...current,
      [key]: isPending,
    }));
  };

  const handleIndexingAction = async (target, mode) => {
    const pendingKey = `indexing:${mode}:${target}`;

    setPending(pendingKey, true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/admin/indexing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ target, mode }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(formatIndexingErrorMessage(data, "Indexing request failed"));
      }

      setStatusMessage(formatIndexingResultMessage(data));
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Indexing request failed"));
    } finally {
      setPending(pendingKey, false);
    }
  };

  return (
    <section className={styles.sectionStack}>
      <section className={`appTopLevelPanel ${styles.heroCard}`}>
        <div className="appHeroCopy">
          <p className="appEyebrow">Indexing</p>
          <h2 className="appPageTitle">Search indexing</h2>
          <div className={styles.heroDescriptionStack}>
            <p className="appPageDescription">Incremental starts the selected indexer run. Full resets the selected indexer and then starts it. All targets both the SQL node-data indexer and the blob-content indexer.</p>
          </div>
        </div>
        {statusMessage ? <p className={styles.statusMessage}>{statusMessage}</p> : null}
        {errorMessage ? <p className={styles.errorMessage}>{errorMessage}</p> : null}
      </section>

      <article className={`appTopLevelPanel ${styles.panel}`}>
        <div className={styles.panelBody}>
          <div className={styles.indexingTableWrapper}>
            <table className={styles.indexingTable}>
              <thead>
                <tr>
                  <th scope="col" className={styles.indexingCornerCell}>scope</th>
                  {INDEXING_COLUMNS.map((column) => (
                    <th key={column.key} scope="col" className={styles.indexingColumnHeader}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {INDEXING_ROWS.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className={styles.indexingRowHeader}>{row.label}</th>
                    {INDEXING_COLUMNS.map((column) => {
                      const pendingKey = `indexing:${column.key}:${row.key}`;

                      return (
                        <td key={`${row.key}:${column.key}`} className={styles.indexingActionCell}>
                          <button
                            type="button"
                            onClick={() => handleIndexingAction(row.key, column.key)}
                            disabled={Boolean(pendingItems[pendingKey])}
                            className="appCompactActionButton appCompactActionButtonNeutral"
                            aria-label={`Start ${column.label} indexing for ${row.label}`}
                          >
                            {pendingItems[pendingKey] ? "Starting..." : "Start"}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </article>
    </section>
  );
}