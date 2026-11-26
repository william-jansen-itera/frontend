import {
  assertInteractionId, interactionError, validateInteractionDescriptor,
  validateInteractionSubmission, validateInteractionValues,
} from '@/shared/interactions';
import { formatQuizAnswer, quizAnswerField, quizOptionExplanations, validateQuizBank } from './quizQuestions.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fail = (message = 'Invalid saved quiz.', status = 409) => { throw interactionError(message, status); };
const keys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const identity = (value) => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(value)) fail();
};

export function validateQuizSource(source, status = 409) {
  const invalid = () => fail('Invalid quiz source snapshot.', status);
  if (!keys(source, ['treeId', 'rootIds', 'leaves', 'excludedLeaves', 'fingerprint']) ||
      !text(source.treeId, 100) || !Array.isArray(source.rootIds) || !source.rootIds.length ||
      source.rootIds.some((id) => !text(id, 100)) || new Set(source.rootIds).size !== source.rootIds.length ||
      typeof source.fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(source.fingerprint) || !Array.isArray(source.leaves) ||
      !source.leaves.length || source.leaves.length > 45 || !Array.isArray(source.excludedLeaves)) invalid();
  let total = 0;
  const ids = new Set();
  for (const leaf of source.leaves) {
    if (!keys(leaf, ['id', 'rootId', 'title', 'path', 'notes', 'revision']) ||
        !text(leaf.id, 100) || ids.has(leaf.id) || !source.rootIds.includes(leaf.rootId) ||
        !text(leaf.title, 2000) || !text(leaf.notes, 8000) ||
        !text(leaf.path, 8000) || !(leaf.revision === null || timestamp(leaf.revision))) invalid();
    ids.add(leaf.id);
    total += leaf.notes.length;
  }
  if (total > 100000) invalid();
  for (const leaf of source.excludedLeaves) {
    if (!keys(leaf, ['id', 'reason']) || !text(leaf.id, 100) || ids.has(leaf.id) ||
        !text(leaf.reason, 1000)) invalid();
    ids.add(leaf.id);
  }
  return source;
}

export function currentQuizQuestion(state) {
  return state.questions.find((question) => question.resolution === null) ?? null;
}

export function quizProgress(state) {
  const total = state.questions.length;
  const count = (outcome) => state.questions.filter((question) => question.resolution?.outcome === outcome).length;
  const correct = count('correct');
  const incorrect = count('incorrect');
  const skipped = count('skipped');
  const answered = correct + incorrect;
  return {
    quizId: state.id, version: state.version, status: state.status, total,
    correct, incorrect, skipped, answered, remaining: total - answered - skipped,
    currentQuestionId: currentQuizQuestion(state)?.id ?? null,
    percentage: total ? 100 * correct / total : 0, provisional: state.status !== 'completed',
  };
}

export function quizResults(state) {
  return {
    ...quizProgress(state),
    outcomes: state.questions.filter((question) => question.resolution).map((question) => ({
      questionId: question.id, question: question.prompt, leafId: question.leafId,
      outcome: question.resolution.outcome, answer: question.resolution.answer, feedback: question.resolution.feedback,
      questionType: question.type, answerText: question.resolution.answer === null ? null
        : formatQuizAnswer(question, question.resolution.answer, state.language),
      optionExplanations: quizOptionExplanations(question, state.language),
    })),
  };
}

export function describeQuiz(state) {
  if (!['active', 'completed'].includes(state.status) || !state.questions.length) {
    fail('A preparing quiz cannot be presented.');
  }
  const progress = quizProgress(state);
  const current = currentQuizQuestion(state);
  const question = current ?? state.questions.at(-1);
  const previous = state.questions.findLast((item) => item.resolution);
  const explanations = previous ? quizOptionExplanations(previous, state.language) : [];
  const summary = state.language === 'da'
    ? `${progress.correct} korrekte, ${progress.incorrect} forkerte, ${progress.skipped} sprunget over. ${progress.remaining} tilbage.`
    : `${progress.correct} correct, ${progress.incorrect} incorrect, ${progress.skipped} skipped. ${progress.remaining} remaining.`;
  return validateInteractionDescriptor({
    schemaVersion: 1, workflow: 'quiz', interactionId: state.id, version: state.version,
    stepId: question.id, title: state.title,
    prompt: state.clarification ? `${question.prompt}\n\n${state.clarification.feedback}` : question.prompt, summary,
    fields: [quizAnswerField(question, state.language)],
    values: { answer: state.pending?.action === 'submit' ? state.pending.values.answer
      : current ? state.clarification?.answer ?? (question.type === 'multiple_choice' ? [] : '')
        : question.resolution.answer ?? (question.type === 'multiple_choice' ? [] : '') },
    status: state.pending ? 'pending' : state.status,
    progress: { current: Math.min(progress.total, progress.total - progress.remaining + 1), total: progress.total },
    allowedActions: state.pending ? ['resume'] : state.status === 'active' ? ['submit', 'reveal'] : [],
    quizProgress: progress,
    ...(explanations.length ? { review: {
      title: state.language === 'da' ? 'Svarforklaringer' : 'Answer explanations',
      details: [previous.prompt, previous.resolution.feedback],
      items: explanations.map((item) => {
        const verdict = state.language === 'da'
          ? item.isCorrect ? 'Korrekt' : 'Forkert'
          : item.isCorrect ? 'Correct' : 'Incorrect';
        const explanation = item.explanation.trim().replace(item.isCorrect
          ? /^(?:correct|korrekt)[.:]\s*/i
          : /^(?:incorrect|forkert|ikke korrekt)[.:]\s*/i, '');
        return {
          id: item.optionId,
          text: `${item.label} - ${verdict}${explanation ? `: ${explanation}` : '.'}`,
        };
      }),
    } } : {}),
  });
}

export function validateQuizState(state) {
  if (!keys(state, ['schemaVersion', 'id', 'version', 'status', 'language', 'title', 'source', 'questions',
    'bank', 'assessments', 'questionCount', 'pending', 'clarification', 'lastSubmissionId', 'presentation', 'createdAt', 'updatedAt']) ||
      state.schemaVersion !== 3 || !integer(state.version) ||
      !['preparing', 'active', 'completed'].includes(state.status) ||
      !(state.status === 'preparing' ? [null, 'und', 'en', 'da'] : ['en', 'da']).includes(state.language) ||
      !text(state.title, 160) || !timestamp(state.createdAt) || !timestamp(state.updatedAt) ||
      !Array.isArray(state.questions) || !Array.isArray(state.bank) || !Array.isArray(state.assessments) ||
      !Number.isSafeInteger(state.questionCount) || state.questionCount < 1 || state.questionCount > 45 ||
      !Object.hasOwn(state, 'pending') ||
      !Object.hasOwn(state, 'clarification') || !Object.hasOwn(state, 'lastSubmissionId') || !Object.hasOwn(state, 'presentation')) fail();
  identity(state.id);
  validateQuizSource(state.source);
  if (state.status === 'preparing') {
    if (state.questions.length || state.bank.length || state.assessments.length ||
        state.pending !== null || state.clarification !== null ||
        state.lastSubmissionId !== null || state.presentation !== null) fail();
    return state;
  }
  validateQuizBank(state.source, { assessments: state.assessments, questions: state.bank }, 409);
  if (state.version < 1 || !state.bank.length || state.questions.length !== Math.min(state.questionCount, state.bank.length)) fail();
  let unresolved = false;
  let lastSubmissionId = null;
  const submissions = new Set();
  const selected = new Set();
  for (const [index, question] of state.questions.entries()) {
    if (!keys(question, ['id', 'leafId', 'type', 'prompt', 'options', 'correctOptionIds', 'referenceAnswer',
      'gradingCriteria', 'learningObjective', 'optionExplanations', 'resolution']) ||
        question.id !== `question-${index + 1}` ||
        !text(question.prompt, 2000) || !text(question.referenceAnswer, 8000) ||
        !text(question.gradingCriteria, 4000) || !Object.hasOwn(question, 'resolution')) fail();
    const generated = {
      leafId: question.leafId, type: question.type, question: question.prompt, options: question.options,
      correctOptionIds: question.correctOptionIds, referenceAnswer: question.referenceAnswer,
      gradingCriteria: question.gradingCriteria, learningObjective: question.learningObjective,
      optionExplanations: question.optionExplanations,
    };
    const bankIndex = state.bank.findIndex((item) => isDeepStrictEqual(item, generated));
    if (bankIndex < 0 || selected.has(bankIndex)) fail('Saved quiz selection does not match its frozen bank.');
    selected.add(bankIndex);
    if (question.resolution === null) { unresolved = true; continue; }
    const resolution = question.resolution;
    if (unresolved || !keys(resolution, ['outcome', 'answer', 'feedback', 'submissionId', 'conversationId', 'turnId']) ||
        !['correct', 'incorrect', 'skipped'].includes(resolution.outcome) ||
        !text(resolution.feedback, 4000) || (resolution.outcome === 'skipped' && resolution.answer !== null)) fail();
    if (resolution.outcome !== 'skipped') {
      try { validateInteractionValues([quizAnswerField(question, state.language)], { answer: resolution.answer }); }
      catch (error) {
        if (error.status === 400) fail('Invalid saved quiz answer.');
        throw error;
      }
    }
    for (const key of ['submissionId', 'conversationId', 'turnId']) identity(resolution[key]);
    if (submissions.has(resolution.submissionId)) fail();
    submissions.add(resolution.submissionId);
    lastSubmissionId = resolution.submissionId;
  }
  const usableNotes = state.assessments.filter((assessment) => assessment.questionCount > 0).length;
  if (new Set(state.questions.map((question) => question.leafId)).size !== Math.min(state.questions.length, usableNotes)) {
    fail('Saved quiz selection must prioritize distinct-note coverage.');
  }
  if ((state.status === 'completed') !== !unresolved || state.lastSubmissionId !== lastSubmissionId) fail();
  if (state.pending !== null) {
    const pending = state.pending;
    if (!keys(pending, ['interactionId', 'stepId', 'version', 'workflow', 'submissionId', 'action', 'values',
      'conversationId', 'turnId', 'capturedConversationId', 'capturedTurnId']) ||
        state.status !== 'active' || pending.interactionId !== state.id ||
        pending.stepId !== currentQuizQuestion(state)?.id || !integer(pending.version) || pending.version >= state.version ||
        pending.workflow !== 'quiz' ||
        !['submit', 'reveal'].includes(pending.action) || submissions.has(pending.submissionId)) fail();
    const { conversationId, turnId, capturedConversationId, capturedTurnId, ...submission } = pending;
    for (const value of [conversationId, turnId, capturedConversationId, capturedTurnId]) identity(value);
    try {
      validateInteractionSubmission(submission);
      validateInteractionValues(pending.action === 'submit' ? describeQuiz({ ...state, pending: null }).fields : [], pending.values);
    } catch (error) {
      if (error.status === 400) fail('Invalid saved quiz submission.');
      throw error;
    }
  }
  if (state.clarification !== null) {
      const clarification = state.clarification;
      if (!keys(clarification, ['questionId', 'answer', 'feedback', 'submissionId']) ||
          state.status !== 'active' || currentQuizQuestion(state)?.type !== 'text' ||
          clarification.questionId !== currentQuizQuestion(state).id ||
          !text(clarification.answer, 2000) || !text(clarification.feedback, 4000)) fail();
      identity(clarification.submissionId);
      if (submissions.has(clarification.submissionId) || state.pending?.submissionId === clarification.submissionId) fail();
  }
  if (state.presentation !== null) {
    const presentation = state.presentation;
    if (!keys(presentation, ['conversationId', 'turnId', 'stepId', 'version']) ||
        !integer(presentation.version) || presentation.version < 1 || presentation.version > state.version ||
        presentation.stepId !== (currentQuizQuestion(state) ?? state.questions.at(-1)).id) fail();
    identity(presentation.conversationId);
    identity(presentation.turnId);
  }
  describeQuiz(state);
  return state;
}

export function validateQuizBinding(binding) {
  assertInteractionId(binding?.conversationId);
  assertInteractionId(binding?.turnId);
  return binding;
}
import { isDeepStrictEqual } from 'node:util';
