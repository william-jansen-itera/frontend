export const COLLECTION_LIMITS = { steps: 10, fields: 5, options: 20, text: 2000, specification: 32768 };
const id = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' };
const option = {
  type: 'object', additionalProperties: false, required: ['id', 'label'],
  properties: { id, label: { type: 'string', minLength: 1, maxLength: 160 } },
};
const field = {
  type: 'object', additionalProperties: false,
  required: ['id', 'label', 'type', 'required', 'maxLength', 'options'],
  properties: {
    id, label: { type: 'string', minLength: 1, maxLength: 160 },
    type: { type: 'string', enum: ['text', 'single_choice', 'multiple_choice', 'yes_no'] },
    required: { type: 'boolean' },
    maxLength: { type: 'integer', minimum: 1, maximum: COLLECTION_LIMITS.text },
    options: { type: 'array', maxItems: COLLECTION_LIMITS.options, items: option },
  },
};
const specification = {
  type: ['object', 'null'], additionalProperties: false, required: ['title', 'purpose', 'steps'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 160 },
    purpose: { type: 'string', minLength: 1, maxLength: 1000 },
    steps: {
      type: 'array', minItems: 1, maxItems: COLLECTION_LIMITS.steps,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'prompt', 'fields'],
        properties: {
          id, prompt: { type: 'string', minLength: 1, maxLength: 1000 },
          fields: { type: 'array', minItems: 1, maxItems: COLLECTION_LIMITS.fields, items: field },
        },
      },
    },
  },
};

export const collectStructuredInputToolDefinition = {
  type: 'function', name: 'collect_structured_input', strict: true,
  description: 'Collect structured information using a saved, agent-provided declarative specification. Available in every Knowledge Trees lane without switching. Start requires specification and interactionId=null. The last specified step submits its fields and completes the collection; there is no added review step. Never supply answers when starting. Each response returns to the agent: process accepts card input already captured by the server; respond accepts your interpretation ONLY of a current explicitly scoped response message. Use the current card\'s allowed action: continue for intermediate steps, submit for the last step. Ask for clarification without advancing if unclear. Status reads; resume recovers an exact ID or, with null, this user/application\'s latest unfinished, unexpired collector across conversations. Resume does not create a replacement. Specifications are immutable, plain data, limited to 32768 characters, with no executable actions, conditional branching, defaults, or approval semantics. Collecting input never approves or executes another tool. No collection during upload-bound turns. Keep IDs internal.',
  parameters: {
    type: 'object', additionalProperties: false,
    required: ['operation', 'interactionId', 'specification', 'response'],
    properties: {
      operation: { type: 'string', enum: ['start', 'process', 'respond', 'status', 'resume'] },
      interactionId: { type: ['string', 'null'], description: 'Null for start or latest resume; otherwise the exact saved ID.' },
      specification: {
        ...specification,
        description: 'Required only for start, otherwise null. Localize title/purpose/prompts/labels to the reply language. Use unique lowercase kebab-case IDs; review, constructor and prototype are reserved. Text options must be empty; choices need options. A yes_no step has one required field and exactly yes/no option IDs. maxLength is 1-2000 (use 2000 for choices).',
      },
      response: {
        type: ['object', 'null'], additionalProperties: false, required: ['action', 'fields'],
        description: 'Only for respond, otherwise null. Interpret the latest explicitly scoped human response, not ordinary chat or old answers. Supply all current fields for continue or submit. Back/cancel have fields=[]. Saved version-one collections retain a separate final review with no fields.',
        properties: {
          action: { type: 'string', enum: ['continue', 'back', 'submit', 'cancel'] },
          fields: {
            type: 'array', maxItems: COLLECTION_LIMITS.fields,
            items: {
              type: 'object', additionalProperties: false, required: ['id', 'value', 'selections'],
              properties: {
                id,
                value: { type: ['string', 'null'], description: 'Exact human text for text fields, or the selected option ID for single_choice/yes_no. Null for multiple_choice.' },
                selections: { type: ['array', 'null'], items: { type: 'string' }, description: 'Selected option IDs for multiple_choice; null for other types.' },
              },
            },
          },
        },
      },
    },
  },
};
