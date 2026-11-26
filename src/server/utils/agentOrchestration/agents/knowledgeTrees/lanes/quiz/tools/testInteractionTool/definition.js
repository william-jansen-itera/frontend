import { interactionError, validateInteractionValues } from '@/shared/interactions';

const STEPS = ['topic', 'note', 'features', 'feedback', 'review'];
const LEGACY_STEPS = STEPS.filter((step) => step !== 'feedback');
const stepsFor = (state) => state.workflowVersion === 1 ? LEGACY_STEPS : STEPS;
const TEXT = {
  en: {
    title: 'Multistep interaction test', topic: 'Choose a topic', note: 'Enter a short note',
    features: 'Choose features to test (optional)', review: 'Review your submitted values',
    completed: 'Interaction completed', cancelled: 'Interaction cancelled',
    nature: 'Nature', technology: 'Technology', choices: 'Choices', navigation: 'Navigation',
    feedback: 'Did you find this test useful?', yes: 'Yes', no: 'No',
    reviewItems: 'Review the test inputs',
    inputOnly: 'This answer is test input only. It does not approve or execute any action.',
  },
  da: {
    title: 'Test af flertrinsinteraktion', topic: 'Vælg et emne', note: 'Skriv en kort note',
    features: 'Vælg funktioner at teste (valgfrit)', review: 'Gennemse dine indsendte værdier',
    completed: 'Interaktionen er afsluttet', cancelled: 'Interaktionen er annulleret',
    nature: 'Natur', technology: 'Teknologi', choices: 'Valg', navigation: 'Navigation',
    feedback: 'Var denne test nyttig?', yes: 'Ja', no: 'Nej',
    reviewItems: 'Gennemse testens input',
    inputOnly: 'Dette svar er kun testinput. Det godkender eller udfører ingen handling.',
  },
};

function fields(step, language) {
  const t = TEXT[language];
  if (step === 'review') return [];
  const options = step === 'topic' ? ['nature', 'technology']
    : step === 'features' ? ['choices', 'navigation']
      : step === 'feedback' ? ['yes', 'no'] : [];
  return [{
    id: step, label: t[step], type: step === 'note' ? 'text'
      : step === 'feedback' ? 'yes_no' : step === 'topic' ? 'single_choice' : 'multiple_choice',
    required: step !== 'features', maxLength: 500,
    options: options.map((id) => ({ id, label: t[id] })),
  }];
}

export const interactionTestDefinition = {
  id: 'interaction-test', version: 2, supportedVersions: [1, 2],
  validate(state) {
    const steps = stepsFor(state);
    if (state.stepIndex < 0 || state.stepIndex >= steps.length ||
        Object.keys(state.values).some((step) => !steps.includes(step))) {
      throw interactionError('Invalid saved test workflow.', 409);
    }
    for (const [step, values] of Object.entries(state.values)) {
      validateInteractionValues(fields(step, state.language), values);
    }
    if ((state.stepIndex > 0 && !state.values.topic) ||
        (state.stepIndex > 1 && !state.values.note) ||
        (state.stepIndex > 2 && !state.values.features) ||
        (state.workflowVersion === 2 && state.stepIndex > 3 && !state.values.feedback) ||
        (state.status === 'completed' && state.stepIndex !== steps.length - 1)) {
      throw interactionError('Saved test workflow is missing earlier steps.', 409);
    }
  },
  describe(state) {
    const steps = stepsFor(state);
    const stepId = steps[state.stepIndex];
    if (!stepId) throw interactionError('Invalid saved interaction step.', 409);
    const t = TEXT[state.language];
    const stepFields = fields(stepId, state.language);
    const items = Object.entries(state.values).flatMap(([step, values]) =>
      fields(step, state.language).map((field) => {
        const value = values[field.id];
        const ids = Array.isArray(value) ? value : [value];
        return {
          id: `${step}-${field.id}`,
          text: `${field.label}: ${field.type === 'text' ? value
            : ids.map((id) => field.options.find((option) => option.id === id)?.label ?? id).join(', ')}`,
        };
      }));
    return {
      schemaVersion: 1, interactionId: state.id, version: state.version, stepId,
      workflow: state.workflow, status: state.pending ? 'pending' : state.status,
      title: t.title, prompt: t[state.status === 'active' ? stepId : state.status],
      fields: stepFields, values: state.values[stepId] ?? Object.fromEntries(
        stepFields.map((field) => [field.id, field.type === 'multiple_choice' ? [] : ''])),
      summary: items.map((item) => item.text).join('\n'), collectedValues: state.values,
      ...(stepId === 'feedback' ? { review: { title: t.reviewItems, details: [t.inputOnly], items } } : {}),
      progress: { current: state.stepIndex + 1, total: steps.length },
      allowedActions: state.pending ? ['resume'] : state.status !== 'active' ? []
        : [...(state.stepIndex > 0 ? ['back'] : []), stepId === 'review' ? 'submit' : 'continue', 'cancel'],
    };
  },
  apply(state, submission) {
    const descriptor = this.describe({ ...state, pending: null });
    if (state.status !== 'active' || descriptor.stepId !== submission.stepId ||
        !descriptor.allowedActions.includes(submission.action)) {
      throw interactionError('The workflow cannot apply this submission.', 409);
    }
    if (submission.action === 'cancel') state.status = 'cancelled';
    else if (submission.action === 'back') state.stepIndex--;
    else if (submission.action === 'submit') state.status = 'completed';
    else {
      const steps = stepsFor(state);
      const step = steps[state.stepIndex];
      const values = validateInteractionValues(descriptor.fields, submission.values);
      if (JSON.stringify(state.values[step]) !== JSON.stringify(values)) {
        for (const later of steps.slice(state.stepIndex + 1)) delete state.values[later];
      }
      state.values[step] = values;
      state.stepIndex++;
    }
  },
};
