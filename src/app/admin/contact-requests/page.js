"use client";

import { useEffect, useState } from "react";
import styles from "../page.module.css";
import { formatTimestamp, getErrorMessage } from "../adminShared";

export default function AdminContactRequestsPage() {
  const [contactRequests, setContactRequests] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  const loadContactRequests = async ({ showLoadingState = true } = {}) => {
    if (showLoadingState) {
      setIsLoading(true);
    }

    try {
      const response = await fetch("/api/admin/contact-requests", { cache: "no-store" });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error || "Requests could not be loaded.");
      }

      setContactRequests(Array.isArray(payload?.requests) ? payload.requests : []);
      setErrorMessage("");
    } catch (error) {
      setContactRequests([]);
      setErrorMessage(getErrorMessage(error, "Requests could not be loaded."));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    Promise.resolve().then(async () => {
      await loadContactRequests({ showLoadingState: false });
    });
  }, []);

  return (
    <>
      <section className={`appTopLevelPanel ${styles.heroCard}`}>
        <div className={styles.heroHeader}>
          <div className="appHeroCopy">
            <p className="appEyebrow">Contact requests</p>
            <h2 className="appPageTitle">Recent intake</h2>
            <div className={styles.heroDescriptionStack}>
              <p className="appPageDescription">Requests received in the last 30 days through the public contact form.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={loadContactRequests}
            disabled={isLoading}
            className="appPrimaryFormButton"
          >
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        {errorMessage ? <p className={styles.errorMessage}>{errorMessage}</p> : null}
      </section>

      <article className={`appTopLevelPanel ${styles.panel}`}>
        <div className={styles.panelBody}>
          {isLoading ? (
            <p className={styles.emptyState}>Loading requests...</p>
          ) : contactRequests.length > 0 ? (
            <div className={styles.list}>
              {contactRequests.map((request) => (
                <article key={request.eventId} className={styles.listItem}>
                  <div className={styles.itemMeta}>
                    <div className={styles.itemHeader}>
                      <span className={styles.reviewBadgeSubmitted}>Submitted</span>
                      <span className={styles.badgeMuted}>{formatTimestamp(request.createdAt)}</span>
                    </div>
                    <h2 className={styles.itemTitle}>{request.name}</h2>
                    <p className={styles.itemDetail}>Email: {request.email}</p>
                    {request.appIdentifier ? <p className={styles.itemDetail}>Application: {request.appIdentifier}</p> : null}
                    <p className={styles.itemDetail}>Event ID: {request.eventId}</p>
                    <p className={styles.itemDetail}>Recorded at: {formatTimestamp(request.createdAt)}</p>
                    <p className={styles.itemDetail}>Using as: {request.contactProfile}</p>
                    {request.company ? <p className={styles.itemDetail}>Company: {request.company}</p> : null}
                    {request.phone ? <p className={styles.itemDetail}>Phone: {request.phone}</p> : null}
                    <p className={styles.itemDetail}>Call requested: {request.wantsCall ? "Yes" : "No"}</p>
                    {request.userAgent ? <p className={styles.itemDetail}>User agent: {request.userAgent}</p> : null}
                    {request.userAgentRaw ? <p className={styles.itemDetail}>Raw user agent: {request.userAgentRaw}</p> : null}
                    <p className={styles.itemDetail}>{request.message}</p>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className={styles.emptyState}>No requests were received in the last 30 days.</p>
          )}
        </div>
      </article>
    </>
  );
}