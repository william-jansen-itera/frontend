"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("Pages.Contact");
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
      setStatusMessage(payload?.message || t("ThankYou"));
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
          <p className="appEyebrow">{t("Title")}</p>
          <h1 className={`${styles.title} appPageTitle`}>{t("Headline")}</h1>
          <p className={styles.cardText}>
            {t("Intro")}
          </p>
        </div>
      </section>

      <section className={styles.contentGrid}>
        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>{t("When")}</p>
          <p className={styles.cardText}>
            {t("WhenText")}
          </p>
        </article>

        <section className={styles.formCard}>
          <div className={styles.formIntro}>
            <p className={styles.cardEyebrow}>{t("Details")}</p>
          </div>

          <form onSubmit={handleSubmit} className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t("Name")}</span>
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
              <span className={styles.fieldLabel}>{t("Email")}</span>
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
              <span className={styles.fieldLabel}>{t("Domain")}</span>
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
              <legend className={styles.fieldLabel}>{t("UseAs")}</legend>
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
                  <span>{t("Individual")}</span>
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
                  <span>{t("CompanyOption")}</span>
                </label>
              </div>
            </fieldset>

            {form.contactProfile === "company" ? (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t("Company")}</span>
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
              <span>{t("WantsCall")}</span>
            </label>

            {form.wantsCall ? (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t("Phone")}</span>
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
                {t(isSubmitting ? "Sending" : "Send")}
              </button>
              <Link href="/about" prefetch={false} className={styles.secondaryLink}>{t("ReadMore")}</Link>
            </div>
          </form>
        </section>
      </section>
    </main>
  );
}