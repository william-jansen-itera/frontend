const nullableString = (description, maxLength = 100) => ({ type: ['string', 'null'], description, maxLength });
const properties = {
  operation: {
    type: 'string',
    enum: ['sources', 'prepare', 'create', 'question', 'answer', 'reveal', 'results', 'list', 'resume', 'restart'],
  },
  quizId: nullableString('Actual saved quiz ID, or null to use the current bound quiz. Resume requires an explicit ID.'),
  setupId: nullableString('Setup ID returned by sources; use it for dependent selection and preparation, otherwise null.'),
  treeId: nullableString('Canonical eligible tree ID supplied unambiguously by the human, otherwise null.'),
  rootIds: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 100, description: 'Actual top-level root IDs explicitly supplied by the human; null when using bound selection.' },
  filter: nullableString('Case-insensitive root-title substring requested to narrow more than 20 roots; otherwise null.', 200),
  version: { type: ['integer', 'null'], minimum: 0, description: 'Exact current quiz version for create, answer, reveal or restart; otherwise null.' },
  questionCount: { type: ['integer', 'null'], minimum: 1, maximum: 45, description: 'Create/restart: chosen run size after offering 25 by default or any integer from 1 to 45. Create null retains the prepared size (initially 25); restart null starts a new 25-question run. The bank still aims for 45 supported questions. Resume preserves the existing run unchanged.' },
  language: {
    type: ['string', 'null'], enum: ['en', 'da', null],
    description: 'Create only: explicit human choice after the tool reports requiresLanguageChoice. Otherwise null: infer the dominant source-note language, never the chat language. Preserve an already selected quiz language.',
  },
  questionId: nullableString('Actual current question ID for answer or reveal.'),
  response: {
    type: ['object', 'null'], additionalProperties: false,
    description: 'Only interpret an explicitly scoped current textarea reply. Never resubmit captured card values or invent future answers.',
    properties: {
      action: { type: 'string', enum: ['submit', 'reveal'] },
      fields: {
        type: 'array', maxItems: 1,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', enum: ['answer'] },
            value: { type: ['string', 'null'], maxLength: 2000 },
            selections: { type: ['array', 'null'], items: { type: 'string' } },
          },
          required: ['id', 'value', 'selections'],
        },
      },
    },
    required: ['action', 'fields'],
  },
  revealRequest: nullableString('For an explicit ordinary-chat reveal/skip request only: exact entire current human message. Null for card/scoped replies. Never interpret ordinary chat as an answer.', 10000),
  restartRequest: nullableString('Restart only: exact entire current human message explicitly choosing to take this quiz again and discard its previous run, including a run-size choice answering your immediately preceding Take again size offer. Never infer this from an unrelated answer or a captured card submission.', 10000),
  offset: { type: ['integer', 'null'], minimum: 0, description: 'List only: pagination offset, otherwise null.' },
};

export const quizToolDefinition = {
  type: 'function', name: 'quiz',
  description: 'Quiz-lane source setup, tool-owned question generation and grading, progress/results and durable resume/restart. Before preparing a new bank, list saved quizzes and offer Continue, Take again or Generate fresh when relevant; do not silently reset or regenerate an existing quiz. Use sources and the generic collector for missing tree/root choices, then prepare and create. Preparation randomly samples 45 eligible notes if more exist and freezes the selection. The bank always aims for 45 distinct supported questions across four types without padding. Before a new run or Take again, offer 25 questions by default or a custom questionCount from 1 to 45 and wait unless the human already chose. Run size never reduces the source sample or bank generation target. Resume preserves the existing run. Restart requires an explicit restartRequest, discards the previous run without history and samples the chosen size (default 25) from the existing bank without generation. Card answers are already captured: call answer with response=null. Scoped textarea replies may supply normalized response; preserve exact free text and map only unambiguous selections. The tool grades and advances or asks unscored clarification; never supply a bank, reference, verdict or score. Explicit human reveal skips instead. Never answer or reveal a question first presented in this turn. Use null for unused properties.',
  strict: true,
  parameters: { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) },
};

const argumentsByOperation = {
  sources: ['setupId', 'treeId', 'rootIds', 'filter'],
  prepare: ['setupId', 'treeId', 'rootIds'],
  create: ['quizId', 'version', 'questionCount', 'language'],
  question: ['quizId'],
  answer: ['quizId', 'version', 'questionId', 'response'],
  reveal: ['quizId', 'version', 'questionId', 'response', 'revealRequest'],
  results: ['quizId'],
  list: ['offset'],
  resume: ['quizId'],
  restart: ['quizId', 'version', 'restartRequest', 'questionCount'],
};

export function validateQuizArguments(args) {
  const keys = Object.keys(properties);
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).length !== keys.length || keys.some((key) => !Object.hasOwn(args, key)) ||
      !Object.hasOwn(argumentsByOperation, args.operation) ||
      ![null, 'en', 'da'].includes(args.language) ||
      (args.questionCount !== null && (!Number.isSafeInteger(args.questionCount) || args.questionCount < 1 || args.questionCount > 45)) ||
      keys.some((key) => key !== 'operation' && !argumentsByOperation[args.operation].includes(key) && args[key] !== null)) {
    throw new Error('Invalid quiz operation arguments. Supply all declared keys and null for unused properties.');
  }
}
