"use client";

import { useState } from "react";
import Link from "next/link";
import PageVisitTracker from "../PageVisitTracker";
import styles from "./page.module.css";

const INITIAL_FORM = {
  contactProfile: "",
  name: "",
  company: "",
  email: "",
  phone: "",
  message: "",
  wantsCall: false,
};

function getErrorMessage(error, fallbackMessage) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallbackMessage;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? "").trim());
}

export default function ContactPage() {
  const [form, setForm] = useState(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const isFormComplete = Boolean(
    form.contactProfile
      && String(form.name ?? "").trim()
      && isValidEmail(form.email)
      && String(form.message ?? "").trim()
      && (form.contactProfile !== "company" || String(form.company ?? "").trim())
      && (!form.wantsCall || String(form.phone ?? "").trim()),
  );

  function handleFieldChange(event) {
    const { name, value, type, checked } = event.target;

    setForm((current) => ({
      ...current,
      ...(name === "contactProfile" && value !== "company" ? { company: "" } : {}),
      ...(name === "wantsCall" && !checked ? { phone: "" } : {}),
      [name]: type === "checkbox" ? checked : value,
    }));
  }

  async function handleSubmit(event) {
    event.preventDefault();

    setIsSubmitting(true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(form),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error || "Your message could not be sent.");
      }

      setForm(INITIAL_FORM);
      setStatusMessage(payload?.message || "Thanks. We will get back to you shortly.");
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Your message could not be sent."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="appPageShell">
      <PageVisitTracker pagePath="/contact" />

      <section className={styles.heroCard}>
        <div className="appHeroCopy">
          <p className="appEyebrow">Contact</p>
          <h1 className={`${styles.title} appPageTitle`}>Tell us the domain you want to unblock</h1>
        </div>
      </section>

      <section className={styles.contentGrid}>
        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>When to reach out</p>
          <p className={styles.cardText}>
            Use this if a domain is blocking the work and you want to see whether MDS fits. Say what the domain is. If you want, say how that knowledge is structured today.
          </p>
        </article>

        <section className={styles.formCard}>
          <div className={styles.formIntro}>
            <p className={styles.cardEyebrow}>Request</p>
            <h2 className={styles.cardTitle}>Leave your details</h2>
          </div>

          <form onSubmit={handleSubmit} className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name</span>
              <input
                type="text"
                name="name"
                value={form.name}
                onChange={handleFieldChange}
                className={styles.input}
                autoComplete="name"
                required
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email</span>
              <input
                type="email"
                name="email"
                value={form.email}
                onChange={handleFieldChange}
                className={styles.input}
                autoComplete="email"
                required
              />
            </label>

            <label className={`${styles.field} ${styles.fieldFull}`}>
              <span className={styles.fieldLabel}>What domain are you trying to unblock?</span>
              <textarea
                name="message"
                value={form.message}
                onChange={handleFieldChange}
                className={styles.textarea}
                rows={7}
                required
              />
            </label>

            <fieldset className={styles.profileFieldset}>
              <legend className={styles.fieldLabel}>I would use this as</legend>
              <div className={styles.profileOptionRow}>
                <label className={styles.profileOption}>
                  <input
                    type="radio"
                    name="contactProfile"
                    value="individual"
                    checked={form.contactProfile === "individual"}
                    onChange={handleFieldChange}
                    required
                  />
                  <span>an individual</span>
                </label>

                <label className={styles.profileOption}>
                  <input
                    type="radio"
                    name="contactProfile"
                    value="company"
                    checked={form.contactProfile === "company"}
                    onChange={handleFieldChange}
                    required
                  />
                  <span>a company</span>
                </label>
              </div>
            </fieldset>

            {form.contactProfile === "company" ? (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Company</span>
                <input
                  type="text"
                  name="company"
                  value={form.company}
                  onChange={handleFieldChange}
                  className={styles.input}
                  autoComplete="organization"
                  required
                />
              </label>
            ) : (
              <div aria-hidden="true" className={styles.fieldPlaceholder} />
            )}

            <label className={styles.checkboxRow}>
              <input
                type="checkbox"
                name="wantsCall"
                checked={form.wantsCall}
                onChange={handleFieldChange}
              />
              <span>I would like a call.</span>
            </label>

            {form.wantsCall ? (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Phone number</span>
                <input
                  type="tel"
                  name="phone"
                  value={form.phone}
                  onChange={handleFieldChange}
                  className={styles.input}
                  autoComplete="tel"
                  required
                />
              </label>
            ) : (
              <div aria-hidden="true" className={styles.fieldPlaceholder} />
            )}

            {statusMessage ? <p className={styles.statusMessage}>{statusMessage}</p> : null}
            {errorMessage ? <p className={styles.errorMessage}>{errorMessage}</p> : null}

            <div className={styles.actionsRow}>
              <button type="submit" className={styles.submitButton} disabled={isSubmitting || !isFormComplete}>
                {isSubmitting ? "Sending..." : "Send request"}
              </button>
              <Link href="/about" className={styles.secondaryLink}>Read more first</Link>
            </div>
          </form>
        </section>
      </section>
    </main>
  );
}