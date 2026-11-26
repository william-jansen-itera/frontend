import { randomInt } from 'node:crypto';
import { interactionError } from '@/shared/interactions';

export const QUIZ_QUESTION_TYPES = ['single_choice', 'multiple_choice', 'yes_no', 'text'];
const text = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;

export function validateQuizQuestion(question, status = 400, questionIndex = null) {
  const invalid = (reason) => {
    throw interactionError(`Invalid typed quiz question${questionIndex === null ? '' : ` ${questionIndex + 1}`}: ${reason}.`, status);
  };
  const fields = ['leafId', 'type', 'learningObjective', 'question', 'options', 'optionExplanations',
    'correctOptionIds', 'referenceAnswer', 'gradingCriteria'];
  if (!question || typeof question !== 'object' || Array.isArray(question) ||
      Object.keys(question).length !== fields.length || fields.some((key) => !Object.hasOwn(question, key))) {
    invalid('expected exactly the declared question fields');
  }
  for (const [field, maximum] of Object.entries({
    leafId: 100, learningObjective: 1000, question: 2000, referenceAnswer: 8000, gradingCriteria: 4000,
  })) {
    if (!text(question[field], maximum)) invalid(`${field} must be nonempty text of at most ${maximum} characters`);
  }
  if (!QUIZ_QUESTION_TYPES.includes(question.type)) invalid('type must be a supported question type');
  for (const field of ['options', 'correctOptionIds', 'optionExplanations']) {
    if (!Array.isArray(question[field])) invalid(`${field} must be an array`);
  }
  if (new Set(question.correctOptionIds).size !== question.correctOptionIds.length) {
    invalid('correctOptionIds must not contain duplicates');
  }
  const options = question.options;
  const correct = question.correctOptionIds;
  if (['text', 'yes_no'].includes(question.type)) {
    if (options.length) invalid('options must be empty for text and yes_no questions');
    if (question.type === 'text' && correct.length) invalid('correctOptionIds must be empty for text questions');
    if (question.type === 'yes_no' && (correct.length !== 1 || !['yes', 'no'].includes(correct[0]))) {
      invalid('correctOptionIds must contain exactly one yes/no ID for yes_no questions');
    }
  } else {
    if (options.length < 3 || options.length > 6) invalid('options must contain 3 to 6 entries for selection questions');
    for (const [index, option] of options.entries()) {
      if (!option || typeof option !== 'object' || Array.isArray(option) || Object.keys(option).length !== 2 ||
          !Object.hasOwn(option, 'id') || !Object.hasOwn(option, 'label')) invalid(`options[${index}] must contain exactly id and label`);
      if (option.id !== `option-${index + 1}`) invalid(`options[${index}].id must follow sequential option-N ordering`);
      if (!text(option.label, 160)) invalid(`options[${index}].label must be nonempty text of at most 160 characters`);
    }
    if (new Set(options.map((option) => option.label.trim().toLocaleLowerCase())).size !== options.length) {
      invalid('options must have distinct labels');
    }
    if (correct.some((id) => !options.some((option) => option.id === id))) invalid('correctOptionIds must reference supplied option IDs');
    if (question.type === 'single_choice' && correct.length !== 1) invalid('single_choice requires exactly one correct option');
    if (question.type === 'multiple_choice' && (correct.length < 2 || correct.length >= options.length)) {
      invalid('multiple_choice requires at least two correct options and at least one incorrect option');
    }
  }
  const optionIds = question.type === 'yes_no' ? ['yes', 'no'] : options.map((option) => option.id);
  if (question.optionExplanations.length !== optionIds.length ||
      new Set(question.optionExplanations.map((item) => item?.optionId)).size !== optionIds.length) {
    invalid('optionExplanations must cover each option exactly once, including both yes/no IDs for yes_no questions');
  }
  for (const [index, item] of question.optionExplanations.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 ||
        !Object.hasOwn(item, 'optionId') || !Object.hasOwn(item, 'explanation')) {
      invalid(`optionExplanations[${index}] must contain exactly optionId and explanation`);
    }
    if (!optionIds.includes(item.optionId)) invalid(`optionExplanations[${index}].optionId must reference a supplied option`);
    if (!text(item.explanation, 1000)) invalid(`optionExplanations[${index}].explanation must be nonempty text of at most 1000 characters`);
  }
  return question;
}

export function validateQuizBank(source, { assessments, questions }, status = 400) {
  const invalid = () => { throw interactionError('Invalid quiz note assessments or question-bank coverage.', status); };
  if (!Array.isArray(assessments) || assessments.length !== source.leaves.length ||
      !Array.isArray(questions) || questions.length > 45) invalid();
  const byLeaf = new Map();
  for (const assessment of assessments) {
    if (!assessment || Object.keys(assessment).length !== 4 ||
        !source.leaves.some((leaf) => leaf.id === assessment.leafId) || byLeaf.has(assessment.leafId) ||
        !text(assessment.reason, 2000) || !Number.isSafeInteger(assessment.questionCount) ||
        assessment.questionCount < 0 || assessment.questionCount > 45 ||
        !Array.isArray(assessment.supportedTypes) ||
        assessment.supportedTypes.some((type) => !QUIZ_QUESTION_TYPES.includes(type)) ||
        new Set(assessment.supportedTypes).size !== assessment.supportedTypes.length ||
        (assessment.questionCount > 0) !== (assessment.supportedTypes.length > 0)) invalid();
    byLeaf.set(assessment.leafId, assessment);
  }
  const objectives = new Set();
  const prompts = new Set();
  for (const [index, question] of questions.entries()) {
    validateQuizQuestion(question, status, index);
    const assessment = byLeaf.get(question.leafId);
    const objective = `${question.leafId}:${question.learningObjective.trim().toLowerCase()}`;
    const prompt = question.question.trim().toLowerCase();
    if (!assessment?.supportedTypes.includes(question.type) || objectives.has(objective) || prompts.has(prompt)) invalid();
    objectives.add(objective);
    prompts.add(prompt);
  }
  for (const assessment of assessments) {
    if (questions.filter((question) => question.leafId === assessment.leafId).length !== assessment.questionCount) invalid();
  }
}

export function shuffleQuizItems(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function selectQuizQuestions(source, bank, questionCount) {
  if (!Number.isSafeInteger(questionCount) || questionCount < 1 || questionCount > 45) {
    throw interactionError('Quiz size must be an integer from 1 to 45.');
  }
  const groups = source.leaves.map((leaf) => bank.filter((question) => question.leafId === leaf.id)).filter((group) => group.length);
  if (questionCount >= bank.length) {
    return Array.from({ length: Math.max(...groups.map((group) => group.length)) }, (_, index) =>
      groups.flatMap((group) => group[index] ? [group[index]] : [])).flat();
  }
  const first = shuffleQuizItems(groups.map((group) => group[randomInt(group.length)]));
  const covered = new Set(first);
  return [...first, ...shuffleQuizItems(bank.filter((question) => !covered.has(question)))].slice(0, questionCount);
}

export function quizAnswerField(question, language) {
  return {
    id: 'answer', type: question.type, required: true,
    label: language === 'da' ? 'Dit svar' : 'Your answer', maxLength: 2000,
    options: question.type === 'yes_no'
      ? [{ id: 'yes', label: language === 'da' ? 'Ja' : 'Yes' }, { id: 'no', label: language === 'da' ? 'Nej' : 'No' }]
      : question.options,
  };
}

export function formatQuizAnswer(question, answer, language) {
  if (question.type === 'text') return answer;
  const ids = Array.isArray(answer) ? answer : [answer];
  return ids.map((id) => quizAnswerField(question, language).options.find((option) => option.id === id).label).join(', ');
}

export function quizOptionExplanations(question, language) {
  if (!question.resolution) throw interactionError('Option explanations require a resolved question.', 409);
  return quizAnswerField(question, language).options.map((option) => ({
    optionId: option.id, label: option.label, isCorrect: question.correctOptionIds.includes(option.id),
    explanation: question.optionExplanations.find((item) => item.optionId === option.id).explanation,
  }));
}

export function gradeQuizSelection(question, answer, language) {
  if (question.type === 'text') throw interactionError('Free answers require model assessment.');
  const selected = Array.isArray(answer) ? answer : [answer];
  const correct = selected.length === question.correctOptionIds.length &&
    selected.every((id) => question.correctOptionIds.includes(id));
  const label = language === 'da' ? correct ? 'Korrekt.' : 'Ikke korrekt.' : correct ? 'Correct.' : 'Incorrect.';
  const expected = question.type === 'multiple_choice' ? question.correctOptionIds : question.correctOptionIds[0];
  return {
    verdict: correct ? 'correct' : 'incorrect',
    feedback: `${label} ${language === 'da' ? 'Korrekt svar' : 'Correct answer'}: ${formatQuizAnswer(question, expected, language)}.`,
  };
}
