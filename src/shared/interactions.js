const ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const ACTIONS = new Set(['back', 'continue', 'submit', 'cancel', 'resume']);

export function interactionError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function assertInteractionId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw interactionError('Invalid interaction identity.');
  return value;
}

export function validateInteractionContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['interactionId', 'stepId', 'version', 'workflow'].includes(key))) {
    throw interactionError('Invalid interaction context.');
  }
  assertInteractionId(value.interactionId);
  assertInteractionId(value.stepId);
  if (value.workflow !== undefined && !['interaction-test', 'structured-input'].includes(value.workflow)) {
    throw interactionError('Unknown interaction workflow.');
  }
  if (!Number.isSafeInteger(value.version) || value.version < 0) throw interactionError('Invalid interaction version.');
  return value;
}

export function validateInteractionSubmission(value) {
  validateInteractionContext({
    interactionId: value?.interactionId, stepId: value?.stepId, version: value?.version, workflow: value?.workflow,
  });
  if (!value || Object.keys(value).some((key) =>
    !['interactionId', 'stepId', 'version', 'workflow', 'submissionId', 'action', 'values'].includes(key)) ||
      !ACTIONS.has(value.action) || !value.values || typeof value.values !== 'object' || Array.isArray(value.values)) {
    throw interactionError('Invalid interaction submission.');
  }
  assertInteractionId(value.submissionId);
  return value;
}

export function validateInteractionDescriptor(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.title !== 'string' ||
      typeof value.prompt !== 'string' || typeof value.summary !== 'string' ||
      !value.values || typeof value.values !== 'object' || Array.isArray(value.values) ||
      !Number.isSafeInteger(value.progress?.current) || !Number.isSafeInteger(value.progress?.total) ||
      value.progress.current < 1 || value.progress.current > value.progress.total ||
      !['active', 'pending', 'completed', 'cancelled'].includes(value.status) ||
      !Array.isArray(value.fields) || !Array.isArray(value.allowedActions) ||
      new Set(value.allowedActions).size !== value.allowedActions.length ||
      (['completed', 'cancelled'].includes(value.status) && value.allowedActions.length > 0) ||
      value.allowedActions.some((action) => !ACTIONS.has(action))) {
    throw interactionError('Invalid interaction descriptor.');
  }
  validateInteractionContext({ interactionId: value.interactionId, stepId: value.stepId, version: value.version });
  if (new Set(value.fields.map((field) => field.id)).size !== value.fields.length) {
    throw interactionError('Duplicate interaction fields.');
  }
  for (const field of value.fields) {
    assertInteractionId(field.id);
    if (!['text', 'single_choice', 'multiple_choice', 'yes_no'].includes(field.type) ||
        typeof field.label !== 'string' || typeof field.required !== 'boolean' || !Array.isArray(field.options) ||
        new Set(field.options.map((option) => option.id)).size !== field.options.length ||
        field.options.some((option) => typeof option.label !== 'string' || !ID.test(option.id))) {
      throw interactionError('Invalid interaction field.');
    }
    if (field.type === 'yes_no' && (value.fields.length !== 1 || field.options.length !== 2 ||
        !field.options.some((option) => option.id === 'yes') ||
        !field.options.some((option) => option.id === 'no'))) {
      throw interactionError('A Yes/No step requires a single field with yes and no options.');
    }
  }
  if (value.review !== undefined && (!value.review || typeof value.review.title !== 'string' ||
      !Array.isArray(value.review.details) || value.review.details.some((detail) => typeof detail !== 'string') ||
      !Array.isArray(value.review.items) || value.review.items.some((item) =>
        !item || typeof item.id !== 'string' || !ID.test(item.id) || typeof item.text !== 'string') ||
      new Set(value.review.items.map((item) => item.id)).size !== value.review.items.length)) {
    throw interactionError('Invalid interaction review.');
  }
  return value;
}

export function validateInteractionValues(fields, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw interactionError('Invalid interaction values.');
  if (Object.keys(values).some((key) => !fields.some((field) => field.id === key))) {
    throw interactionError('The submission contains an unknown field.');
  }
  const result = {};
  for (const field of fields) {
    const value = values[field.id];
    if (field.type === 'multiple_choice') {
      if (!Array.isArray(value) || new Set(value).size !== value.length ||
          value.some((id) => !field.options.some((option) => option.id === id)) ||
          (field.required && !value.length)) throw interactionError(`Invalid selection: ${field.label}`);
    } else if (typeof value !== 'string' || (field.required && !value.trim()) ||
        value.length > (field.maxLength ?? 2000) ||
        (['single_choice', 'yes_no'].includes(field.type) && (field.required || value !== '') &&
          !field.options.some((option) => option.id === value))) {
      throw interactionError(`Invalid value: ${field.label}`);
    }
    result[field.id] = value;
  }
  return result;
}

export function interpretInteractionText(descriptor, text, submissionId) {
  const command = text.trim().toLocaleLowerCase();
  const commands = {
    back: 'back', tilbage: 'back', continue: 'continue', 'fortsæt': 'continue',
    submit: 'submit', complete: 'submit', afslut: 'submit', indsend: 'submit', cancel: 'cancel',
    annuller: 'cancel', resume: 'resume', genoptag: 'resume',
  };
  let action = commands[command];
  let values = {};
  if (!action && descriptor.status === 'active' && descriptor.fields.length === 1) {
    const field = descriptor.fields[0];
    if (field.type === 'text') {
      values = { [field.id]: text };
    } else {
      const parts = field.type === 'multiple_choice' ? text.split(',').map((part) => part.trim()) : [text.trim()];
      const selected = parts.map((part) => field.options.find((option) =>
        [option.id, option.label].some((candidate) => candidate.toLocaleLowerCase() === part.toLocaleLowerCase()))?.id);
      if (selected.some((id) => !id)) return null;
      values = { [field.id]: field.type === 'multiple_choice' ? selected : selected[0] };
    }
    action = 'continue';
  }
  if (!action) return null;
  if (action === 'continue' && !Object.keys(values).length) values = descriptor.values;
  return {
    interactionId: descriptor.interactionId, stepId: descriptor.stepId, version: descriptor.version,
    action, values: ['continue', 'submit'].includes(action) ? values : {}, submissionId,
  };
}

export function formatInteractionMessage(descriptor, action, values, actionLabel) {
  const lines = [actionLabel];
  if (['continue', 'submit'].includes(action)) {
    for (const field of descriptor.fields) {
      const value = values[field.id];
      const ids = Array.isArray(value) ? value : [value];
      const display = field.type === 'text' ? value : ids.map((id) =>
        field.options.find((option) => option.id === id)?.label ?? id).join(', ');
      lines.push(`${field.label}: ${display ?? ''}`);
    }
  }
  return lines.join('\n');
}
