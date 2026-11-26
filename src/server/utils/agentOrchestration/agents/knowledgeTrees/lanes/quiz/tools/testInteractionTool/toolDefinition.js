export const testInteractionToolDefinition = {
  type: 'function', name: 'test_multistep_interaction', strict: true,
  description: 'Run the retained fixed multistep test when the human asks to "test quiz interaction". This is not actual quiz generation or grading. Start creates a saved interaction; process handles input already captured by the server; status reads without advancing; resume recovers/reopens a saved interaction, finishing pending input once. Resume with interactionId=null uses trusted current interaction context if present, otherwise finds the most recently updated unfinished, unexpired test interaction owned by this user in this application across conversations. If none exists, report that and ask before starting a new test. Use only in the quiz lane; switch there first. Never invent steps, answers, interaction IDs, or a human submission.',
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['start', 'process', 'status', 'resume'] },
      interactionId: { type: ['string', 'null'], description: 'Null for start or resume without a supplied ID; otherwise the exact saved interaction ID. Resume with null uses trusted current context, or selects the latest unfinished, unexpired test across the current user/application conversations.' },
    },
    required: ['operation', 'interactionId'], additionalProperties: false,
  },
};
