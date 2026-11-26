"use client";

import { useId, useState } from "react";
import { formatInteractionMessage } from "@/shared/interactions";
import styles from "./page.module.css";

export function InteractionControl({
  title, prompt, progress, identity, summary, review, fields = [], initialValues = {}, actions,
  disabled, readOnly, fieldsDisabled = false, translate, onAction,
}) {
  const formId = useId();
  const [values, setValues] = useState(initialValues);
  const inactive = disabled || readOnly || fieldsDisabled;
  function act(action) {
    if (disabled || readOnly) return;
    onAction({ action: action.id, values: action.submitsFields ? values : {} });
  }
  const forward = actions.find((action) => action.submitsFields);
  return (
    <section className={styles.interactionCard} aria-label={title}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <h3>{title}</h3>
      {progress ? <p>{translate("Interaction.Step", progress)}</p> : null}
      <p>{prompt}</p>
      {identity ? <p className={styles.interactionIdentity}>{translate("Interaction.Identity")}: <code>{identity}</code></p> : null}
      {summary ? <p className={styles.interactionSummary}>{summary}</p> : null}
      {review ? (
        <details>
          <summary>{review.title}</summary>
          {review.details.map((detail) => <p key={detail}>{detail}</p>)}
          <ul>{review.items.map((item) => <li key={item.id}>{item.text}</li>)}</ul>
        </details>
      ) : null}
      <form onSubmit={(event) => { event.preventDefault(); if (forward && !inactive) act(forward); }}>
        {fields.map((field) => (
          <fieldset key={field.id} disabled={inactive} className={styles.interactionField}>
            <legend>{field.label}</legend>
            {field.type === "text" ? (
              <textarea aria-label={field.label} required={field.required} maxLength={field.maxLength}
                value={values[field.id] ?? ""}
                onChange={(event) => setValues({ ...values, [field.id]: event.target.value })} />
            ) : field.options.map((option) => (
              <label key={option.id} className={styles.interactionOption}>
                <input type={["single_choice", "yes_no"].includes(field.type) ? "radio" : "checkbox"}
                  name={`${identity ?? formId}-${field.id}`} value={option.id}
                  required={["single_choice", "yes_no"].includes(field.type) && field.required}
                  checked={["single_choice", "yes_no"].includes(field.type) ? values[field.id] === option.id : (values[field.id] ?? []).includes(option.id)}
                  onChange={(event) => setValues({
                    ...values,
                    [field.id]: ["single_choice", "yes_no"].includes(field.type) ? option.id
                      : event.target.checked ? [...(values[field.id] ?? []), option.id]
                        : (values[field.id] ?? []).filter((id) => id !== option.id),
                  })} />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
        ))}
        {!readOnly ? (
          <div className={styles.approvalActions}>
            {actions.map((action) => (
              <button key={action.id} type={action === forward ? "submit" : "button"}
                className="appCompactActionButton appCompactActionButtonNeutral"
                disabled={disabled}
                onClick={action === forward ? undefined : () => act(action)}>
                {action.label}
              </button>
            ))}
          </div>
        ) : <p>{translate("Interaction.ReadOnly")}</p>}
      </form>
    </section>
  );
}

export default function InteractionCard({ interaction, disabled, readOnly, translate, onAction, onReplyInChat }) {
  const yesNoField = interaction.allowedActions.includes("submit") ? null
    : interaction.fields.find((field) => field.type === "yes_no");
  const actions = interaction.allowedActions.flatMap((action) => (
    action === "continue" && yesNoField
      ? yesNoField.options.map((option) => ({ id: option.id, label: option.label }))
      : [{
        id: action, label: translate(`Interaction.Actions.${action}`),
        submitsFields: ["continue", "submit"].includes(action),
      }]
  ));
  return (
    <>
    <InteractionControl
      title={interaction.title} prompt={interaction.prompt} progress={interaction.progress}
      summary={interaction.summary} review={interaction.review}
      fields={yesNoField ? [] : interaction.fields} initialValues={interaction.values}
      fieldsDisabled={interaction.status !== "active"} disabled={disabled} readOnly={readOnly}
      actions={actions}
      translate={translate}
      onAction={({ action, values }) => {
        const answer = yesNoField?.options.find((option) => option.id === action);
        const submissionAction = answer ? "continue" : action;
        const submissionValues = answer ? { [yesNoField.id]: answer.id } : values;
        onAction({
          action: submissionAction, values: submissionValues,
          message: formatInteractionMessage(interaction, submissionAction, submissionValues,
            answer?.label ?? translate(`Interaction.Actions.${action}`)),
        });
      }} />
    {onReplyInChat && !readOnly && interaction.status === "active" ? (
      <button type="button" className="appCompactActionButton appCompactActionButtonNeutral"
        disabled={disabled} onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onReplyInChat(); }}>
        {translate("Interaction.ReplyInChat")}
      </button>
    ) : null}
    </>
  );
}
