import { interactionError, validateInteractionValues } from '@/shared/interactions';
import { COLLECTION_LIMITS as limits } from './toolDefinition.js';

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw interactionError('Invalid structured collection object.');
  }
}

function text(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw interactionError('Invalid structured collection text.');
  }
}

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(value) ||
      ['review', 'constructor', 'prototype'].includes(value)) {
    throw interactionError('Invalid or reserved structured collection ID.');
  }
}

function items(value, maximum, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw interactionError('Invalid structured collection item count.');
  }
  if (new Set(value.map((item) => item?.id)).size !== value.length) {
    throw interactionError('Duplicate structured collection IDs.');
  }
}

export function validateCollectionSpecification(specification) {
  object(specification, ['title', 'purpose', 'steps']);
  text(specification.title, 160);
  text(specification.purpose, 1000);
  items(specification.steps, limits.steps, 1);
  for (const step of specification.steps) {
    object(step, ['id', 'prompt', 'fields']);
    identifier(step.id);
    text(step.prompt, 1000);
    items(step.fields, limits.fields, 1);
    for (const field of step.fields) {
      object(field, ['id', 'label', 'type', 'required', 'maxLength', 'options']);
      identifier(field.id);
      text(field.label, 160);
      if (!['text', 'single_choice', 'multiple_choice', 'yes_no'].includes(field.type) ||
          typeof field.required !== 'boolean' || !Number.isInteger(field.maxLength) ||
          field.maxLength < 1 || field.maxLength > limits.text) {
        throw interactionError('Invalid structured collection field.');
      }
      items(field.options, limits.options, field.type === 'text' ? 0 : 1);
      for (const option of field.options) {
        object(option, ['id', 'label']);
        identifier(option.id);
        text(option.label, 160);
      }
      if (field.type === 'text' && field.options.length ||
          field.type === 'yes_no' && (step.fields.length !== 1 || !field.required ||
            field.options.length !== 2 || !field.options.some(({ id }) => id === 'yes') ||
            !field.options.some(({ id }) => id === 'no'))) {
        throw interactionError('Invalid text or Yes/No collection field.');
      }
    }
  }
  if (JSON.stringify(specification).length > limits.specification) {
    throw interactionError('The structured collection specification is too large.');
  }
  return specification;
}

function stepsFor(state) {
  const steps = validateCollectionSpecification(state.specification).steps;
  return state.workflowVersion === 1 ? [...steps, { id: 'review', fields: [] }] : steps;
}

export function parseCollectionResponse(response, descriptor) {
  object(response, ['action', 'fields']);
  items(response.fields, limits.fields);
  if (!descriptor.allowedActions.includes(response.action)) throw interactionError('This response action is unavailable.');
  const submitsFields = ['continue', 'submit'].includes(response.action);
  if (!submitsFields && response.fields.length) throw interactionError('Navigation cannot supply answers.');
  const values = Object.fromEntries(response.fields.map((field) => {
    object(field, ['id', 'value', 'selections']);
    const expected = descriptor.fields.find(({ id }) => id === field.id);
    if (!expected || (expected.type === 'multiple_choice' ? field.value !== null : field.selections !== null)) {
      throw interactionError('The response does not match the current fields.');
    }
    return [field.id, expected.type === 'multiple_choice' ? field.selections : field.value];
  }));
  return {
    action: response.action,
    values: validateInteractionValues(submitsFields ? descriptor.fields : [], values),
  };
}

const LABELS = {
  en: { review: 'Review your submitted values', completed: 'Collection completed', cancelled: 'Collection cancelled' },
  da: { review: 'Gennemse dine indsendte værdier', completed: 'Indsamlingen er afsluttet', cancelled: 'Indsamlingen er annulleret' },
};

export const structuredInputDefinition = {
  id: 'structured-input', version: 2, supportedVersions: [1, 2],
  initialize(specification) {
    return { specification: structuredClone(validateCollectionSpecification(specification)) };
  },
  validate(state) {
    const steps = stepsFor(state);
    if (state.stepIndex < 0 || state.stepIndex >= steps.length ||
        Object.keys(state.values).some((id) => !steps.some((step) => step.id === id)) ||
        steps.slice(0, state.stepIndex).some((step) => !Object.hasOwn(state.values, step.id)) ||
        (state.status === 'completed' && (state.stepIndex !== steps.length - 1 ||
          state.workflowVersion !== 1 && !Object.hasOwn(state.values, steps.at(-1).id)))) {
      throw interactionError('Invalid saved structured collection.', 409);
    }
    for (const [id, values] of Object.entries(state.values)) {
      validateInteractionValues(steps.find((step) => step.id === id).fields, values);
    }
  },
  describe(state) {
    const steps = stepsFor(state);
    const step = steps[state.stepIndex];
    if (!step) throw interactionError('Invalid structured collection step.', 409);
    const review = step.id === 'review';
    const labels = LABELS[state.language];
    const reviewItems = steps.flatMap((previous) => !state.values[previous.id] ? [] : previous.fields.map((field) => {
      const value = state.values[previous.id][field.id];
      const selected = Array.isArray(value) ? value : [value];
      return {
        id: `${previous.id}-${field.id}`,
        text: `${field.label}: ${field.type === 'text' ? value
          : selected.map((id) => field.options.find((option) => option.id === id)?.label ?? id).join(', ')}`,
      };
    }));
    return {
      schemaVersion: 1, interactionId: state.id, version: state.version, stepId: step.id,
      workflow: state.workflow, status: state.pending ? 'pending' : state.status,
      title: state.specification.title,
      prompt: state.status !== 'active' ? labels[state.status] : review ? labels.review : step.prompt,
      fields: step.fields,
      values: state.values[step.id] ?? Object.fromEntries(step.fields.map((field) =>
        [field.id, field.type === 'multiple_choice' ? [] : ''])),
      summary: reviewItems.map(({ text }) => text).join('\n'), collectedValues: state.values,
      ...(review ? { review: { title: labels.review, details: [state.specification.purpose], items: reviewItems } } : {}),
      progress: { current: state.stepIndex + 1, total: steps.length },
      allowedActions: state.pending ? ['resume'] : state.status !== 'active' ? []
        : [...(state.stepIndex > 0 ? ['back'] : []), state.stepIndex === steps.length - 1 ? 'submit' : 'continue', 'cancel'],
    };
  },
  apply(state, submission) {
    const descriptor = this.describe({ ...state, pending: null });
    if (state.status !== 'active' || submission.stepId !== descriptor.stepId ||
        !descriptor.allowedActions.includes(submission.action)) throw interactionError('Invalid collection transition.', 409);
    if (submission.action === 'cancel') state.status = 'cancelled';
    else if (submission.action === 'back') state.stepIndex--;
    else if (submission.action === 'submit' && descriptor.stepId === 'review') state.status = 'completed';
    else {
      const values = validateInteractionValues(descriptor.fields, submission.values);
      if (JSON.stringify(state.values[descriptor.stepId]) !== JSON.stringify(values)) {
        for (const later of stepsFor(state).slice(state.stepIndex + 1)) delete state.values[later.id];
      }
      state.values[descriptor.stepId] = values;
      if (submission.action === 'submit') state.status = 'completed';
      else state.stepIndex++;
    }
  },
};
