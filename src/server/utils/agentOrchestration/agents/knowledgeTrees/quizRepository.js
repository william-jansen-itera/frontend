import { randomUUID } from 'node:crypto';
import {
  getPersonalCacheContext, mutatePersonalCacheNotes, readPersonalCacheNotes,
} from '@/server/utils/agentOrchestration/personalCacheTreeRepository';
import { getAuditMetadata } from '@/server/utils/tree/treeCatalog';
import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';
import { assertInteractionId, interactionError } from '@/shared/interactions';
import { validatePresentedInteractionInput } from '../../interactions/interactionBindings.js';
import {
  currentQuizQuestion, describeQuiz, quizProgress, validateQuizBinding, validateQuizSource, validateQuizState,
} from './quizState.js';
import { gradeQuizSelection, selectQuizQuestions, validateQuizBank } from './quizQuestions.js';

const conflict = (message) => { throw interactionError(message, 409); };
const path = (id) => ['Knowledge Trees', 'Quizzes', 'By Quiz ID', assertInteractionId(id)];
const boundedText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const DEFAULT_RUN_QUESTION_COUNT = 25;

function decode(notes, id) {
  let state;
  try { state = JSON.parse(notes); } catch { conflict('Invalid saved quiz JSON.'); }
  validateQuizState(state);
  if (state.id !== id) conflict('Saved quiz identity mismatch.');
  return state;
}

function expected(state, version, status) {
  if (state.version !== version || state.status !== status) conflict('The quiz changed. Resume it before continuing.');
}

function startRun(state) {
  state.questions = selectQuizQuestions(state.source, state.bank, state.questionCount).map((item, index) => ({
    id: `question-${index + 1}`, leafId: item.leafId, type: item.type, prompt: item.question,
    options: structuredClone(item.options), correctOptionIds: [...item.correctOptionIds],
    optionExplanations: structuredClone(item.optionExplanations), learningObjective: item.learningObjective,
    referenceAnswer: item.referenceAnswer, gradingCriteria: item.gradingCriteria, resolution: null,
  }));
  state.status = 'active';
  state.pending = null;
  state.clarification = null;
  state.lastSubmissionId = null;
  state.presentation = null;
  state.version++;
  return state;
}

export function createQuizRepository() {
  async function mutate(principal, id, change, createIfMissing = false) {
    const { personalCacheTreeId: treeId, updatedBy } = await getPersonalCacheContext(principal);
    return mutatePersonalCacheNotes({
      treeId, principal, updatedBy, pathSegments: path(id), createIfMissing, expireAfterInactivity: false,
      mutate(notes) {
        const state = notes ? decode(notes, id) : null;
        if (!state && !createIfMissing) throw interactionError('Quiz was not found for this user.', 404);
        const next = change(state);
        next.updatedAt = new Date().toISOString();
        validateQuizState(next);
        return { notes: JSON.stringify(next), result: structuredClone(next) };
      },
    });
  }
  return {
    async createPrepared(principal, source, language = 'en') {
      validateQuizSource(source, 400);
      if (![null, 'en', 'da'].includes(language)) throw interactionError('Unsupported quiz language.');
      const snapshot = structuredClone(source);
      const id = randomUUID();
      return mutate(principal, id, (state) => {
        if (state) conflict('Quiz already exists.');
        return {
          schemaVersion: 3, id, version: 0, status: 'preparing', language, title: 'Quiz', source: snapshot,
          bank: [], assessments: [], questionCount: DEFAULT_RUN_QUESTION_COUNT,
          questions: [], pending: null, clarification: null, lastSubmissionId: null, presentation: null, createdAt: new Date().toISOString(),
        };
      }, true);
    },
    async read(principal, id) {
      const { personalCacheTreeId: treeId } = await getPersonalCacheContext(principal);
      const notes = await readPersonalCacheNotes({
        treeId, principal, pathSegments: path(id), createIfMissing: false, expireAfterInactivity: false,
      });
      if (!notes) throw interactionError('Quiz was not found for this user.', 404);
      return decode(notes, id);
    },
    async configurePrepared(principal, id, { version, language, questionCount }, binding) {
      validateQuizBinding(binding);
      if (![null, 'en', 'da', 'und'].includes(language)) throw interactionError('Unsupported quiz language.');
      if (!Number.isSafeInteger(questionCount) || questionCount < 1 || questionCount > 45) {
        throw interactionError('Quiz size must be from 1 to 45 questions.');
      }
      return mutate(principal, id, (state) => {
        expected(state, version, 'preparing');
        if (state.language !== null && state.language !== 'und' && state.language !== language) {
          conflict('The prepared quiz language is already selected.');
        }
        state.language = language;
        state.questionCount = questionCount;
        state.version++;
        return state;
      });
    },
    async activate(principal, id, { version, title, questions, assessments, questionCount, language }, binding) {
      validateQuizBinding(binding);
      return mutate(principal, id, (state) => {
        expected(state, version, 'preparing');
        if (!['en', 'da'].includes(state.language) || language !== undefined && language !== state.language) {
          conflict('Select the quiz language before activating questions in that language.');
        }
        if (!boundedText(title, 160)) throw interactionError('Provide a quiz title of at most 160 characters.');
        validateQuizBank(state.source, { assessments, questions });
        if (!questions.length) throw interactionError('The selected notes do not support any quiz questions. Choose different sources.');
        state.bank = structuredClone(questions);
        state.assessments = structuredClone(assessments);
        if (questionCount !== undefined) state.questionCount = questionCount;
        state.title = title;
        return startRun(state);
      });
    },
    async restart(principal, id, { version, questionCount = DEFAULT_RUN_QUESTION_COUNT }, binding) {
      validateQuizBinding(binding);
      return mutate(principal, id, (state) => {
        if (state.status === 'preparing') conflict('Only a quiz with a saved question bank can be restarted.');
        expected(state, version, state.status);
        state.questionCount = questionCount;
        return startRun(state);
      });
    },
    async capture(principal, input, binding) {
      validateQuizBinding(binding);
      return mutate(principal, input?.interactionId, (state) => {
        if (state.status !== 'active') conflict('Only an active quiz accepts answers.');
        if (input.submissionId === state.clarification?.submissionId) conflict('This answer was already submitted for clarification.');
        const values = validatePresentedInteractionInput(state, describeQuiz(state), input, binding);
        state.pending = {
          ...input, values, ...binding,
          capturedConversationId: binding.conversationId, capturedTurnId: binding.turnId,
        };
        state.version++;
        return state;
      });
    },
    async clarify(principal, id, input, binding) {
      validateQuizBinding(binding);
      return mutate(principal, id, (state) => {
        if (!input || Object.keys(input).length !== 3 ||
            Object.keys(input).some((key) => !['version', 'questionId', 'feedback'].includes(key))) {
          conflict('Invalid quiz clarification.');
        }
        expected(state, input.version, 'active');
        const question = currentQuizQuestion(state);
        const pending = state.pending;
        if (!question || question.id !== input.questionId || question.type !== 'text' || pending?.action !== 'submit' ||
            pending.conversationId !== binding.conversationId || pending.turnId !== binding.turnId ||
            !boundedText(input.feedback, 4000)) conflict('Only a matching captured free answer can request clarification.');
        state.clarification = {
          questionId: question.id, answer: pending.values.answer, feedback: input.feedback, submissionId: pending.submissionId,
        };
        state.pending = null;
        state.presentation = null;
        state.version++;
        return state;
      });
    },
    async resolve(principal, id, input, binding) {
      validateQuizBinding(binding);
      return mutate(principal, id, (state) => {
        expected(state, input?.version, 'active');
        const question = currentQuizQuestion(state);
        const pending = state.pending;
        if (!input || Object.keys(input).some((key) => !['version', 'questionId', 'outcome', 'feedback'].includes(key)) ||
            question?.id !== input.questionId || !pending || pending.stepId !== question.id ||
            pending.conversationId !== binding.conversationId || pending.turnId !== binding.turnId ||
            !['correct', 'incorrect', 'skipped'].includes(input.outcome) ||
            (input.outcome === 'skipped' ? pending.action !== 'reveal' : pending.action !== 'submit')) {
          conflict('A matching captured human answer or reveal is required to resolve this question.');
        }
        if (!boundedText(input.feedback, 4000)) throw interactionError('Quiz feedback must contain at most 4000 characters.');
        if (input.outcome !== 'skipped' && question.type !== 'text' &&
            gradeQuizSelection(question, pending.values.answer, state.language).verdict !== input.outcome) {
          conflict('Selection scores must match the saved answer key exactly.');
        }
        question.resolution = {
          outcome: input.outcome, answer: pending.action === 'submit' ? pending.values.answer : null,
          feedback: input.feedback, submissionId: pending.submissionId,
          // Resuming transfers grading authority, not the original human capture provenance.
          conversationId: pending.capturedConversationId, turnId: pending.capturedTurnId,
        };
        state.lastSubmissionId = pending.submissionId;
        state.pending = null;
        state.clarification = null;
        state.presentation = null;
        state.version++;
        if (!currentQuizQuestion(state)) state.status = 'completed';
        return state;
      });
    },
    async resume(principal, id, binding) {
      validateQuizBinding(binding);
      return mutate(principal, id, (state) => {
        if (state.pending) {
          state.pending.conversationId = binding.conversationId;
          state.pending.turnId = binding.turnId;
        }
        state.presentation = null;
        state.version++;
        return state;
      });
    },
    async present(principal, id, { conversationId, turnId, expectedVersion }) {
      validateQuizBinding({ conversationId, turnId });
      return mutate(principal, id, (state) => {
        if (state.version !== expectedVersion) conflict('The quiz changed before presentation. Resume it.');
        const descriptor = describeQuiz(state);
        state.presentation = { conversationId, turnId, stepId: descriptor.stepId, version: state.version + 1 };
        state.version++;
        return state;
      });
    },
    async list(principal, { offset = 0, limit = 20 } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw interactionError('Invalid quiz pagination.');
      const { personalCacheTreeId: treeId } = await getPersonalCacheContext(principal);
      const owner = getAuditMetadata(principal).updatedByObjectId;
      if (!owner) throw interactionError('An authenticated principal is required to list quizzes.', 401);
      const result = await withSqlConnection(async () => new sql.Request()
        .input('tree_id', sql.Int, Number(treeId))
        .input('owner', sql.NVarChar(100), owner)
        .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
        .input('offset', sql.Int, offset)
        .input('page_size', sql.Int, limit + 1)
        .query(`
          SELECT quiz.text AS quizId, details.notes
          FROM tree_nodes quiz
          INNER JOIN tree_nodes by_id ON by_id.id = quiz.parent_id AND by_id.tree_instance_id = quiz.tree_instance_id
          INNER JOIN tree_nodes quizzes ON quizzes.id = by_id.parent_id AND quizzes.tree_instance_id = quiz.tree_instance_id
          INNER JOIN tree_nodes knowledge ON knowledge.id = quizzes.parent_id AND knowledge.tree_instance_id = quiz.tree_instance_id
          INNER JOIN tree_node_details details ON details.tree_node_id = quiz.id
          INNER JOIN tree_instance tree ON tree.id = quiz.tree_instance_id
          INNER JOIN application_instance app ON app.id = tree.application_instance_id
          WHERE tree.id = @tree_id AND tree.deleted_at IS NULL AND tree.is_private = 1
            AND LOWER(LTRIM(RTRIM(tree.display_name))) = N'personal cache'
            AND tree.owner_object_id = @owner AND app.app_identifier = @application_identifier
            AND knowledge.parent_id IS NULL AND knowledge.text = N'Knowledge Trees'
            AND knowledge.deleted_at IS NULL AND knowledge.is_leaf_node = 0
            AND quizzes.text = N'Quizzes' AND quizzes.deleted_at IS NULL AND quizzes.is_leaf_node = 0
            AND by_id.text = N'By Quiz ID' AND by_id.deleted_at IS NULL AND by_id.is_leaf_node = 0
            AND quiz.deleted_at IS NULL AND quiz.is_leaf_node = 1
            AND JSON_VALUE(CASE WHEN ISJSON(details.notes) = 1 THEN details.notes END, '$.schemaVersion') = N'3'
            AND JSON_VALUE(CASE WHEN ISJSON(details.notes) = 1 THEN details.notes END, '$.id') = quiz.text
            AND NOT EXISTS (SELECT 1 FROM tree_nodes child WHERE child.parent_id = quiz.id)
            AND NOT EXISTS (SELECT 1 FROM tree_node_detail_files files WHERE files.tree_node_id = quiz.id)
          ORDER BY details.updated_at DESC, quiz.id DESC
          OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;
        `));
      const states = result.recordset.map((row) => decode(row.notes, row.quizId));
      return {
        quizzes: states.slice(0, limit).map((state) => ({
          ...quizProgress(state), title: state.title, updatedAt: state.updatedAt,
          treeId: state.source.treeId, rootIds: [...state.source.rootIds],
          availableQuestions: state.bank.length, requestedQuestionCount: state.questionCount,
        })),
        offset, nextOffset: states.length > limit ? offset + limit : null,
      };
    },
  };
}
