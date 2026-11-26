import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = {
      personalCacheTreeRepository: `
        export const getPersonalCacheContext = async (principal) => {
          if (!principal?.userId) throw new Error('Authentication required');
          return { personalCacheTreeId: principal.app === 'other' ? 8 : principal.userId === 'other' ? 9 : 7, updatedBy: {} };
        };
        export const mutatePersonalCacheNotes = (options) => globalThis.__quizMutate(options);
        export const readPersonalCacheNotes = (options) => globalThis.__quizRead(options);
      `,
      treeCatalog: 'export const getAuditMetadata = (principal) => ({ updatedByObjectId: principal?.userId });',
      sql: `
        export const getRequiredApplicationIdentifier = () => 'app-a';
        export const withSqlConnection = async (callback) => callback();
        class Request {
          inputs = {};
          input(name, type, value) { this.inputs[name] = value; return this; }
          query(query) { return globalThis.__quizQuery({ query, inputs: this.inputs }); }
        }
        export const sql = { Request, Int: 'int', NVarChar: () => 'nvarchar' };
      `,
    };
    const stub = specifier.startsWith('@/') && stubs[specifier.split('/').at(-1)];
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.js`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { createQuizRepository } = await import('./quizRepository.js');
const { currentQuizQuestion, describeQuiz, quizProgress, quizResults, validateQuizState } = await import('./quizState.js');
const repository = createQuizRepository();
const owner = { userId: 'owner', app: 'app-a' };
const binding = { conversationId: 'conversation-1', turnId: 'turn-1' };
const human = { ...binding, turnId: 'turn-2' };
const source = (count = 3) => ({
  treeId: '42', rootIds: ['root-1'], fingerprint: 'a'.repeat(64), excludedLeaves: [{ id: 'excluded', reason: 'empty' }],
  leaves: Array.from({ length: count }, (_, index) => ({
    id: `leaf-${index + 1}`, rootId: 'root-1', title: `Leaf ${index + 1}`,
    path: `Root > Leaf ${index + 1}`, notes: `Private notes ${index + 1}`, revision: null,
  })),
});
const bank = (snapshot) => snapshot.leaves.map((leaf) => ({
  leafId: leaf.id, type: 'text', options: [], correctOptionIds: [], optionExplanations: [],
  learningObjective: `Understand ${leaf.id}`, question: `Question for ${leaf.id}?`,
  referenceAnswer: `SECRET reference ${leaf.id}`, gradingCriteria: `SECRET criteria ${leaf.id}`,
}));
const assessments = (snapshot) => snapshot.leaves.map((leaf) => ({
  leafId: leaf.id, supportedTypes: ['text'], questionCount: 1, reason: 'One supported learning objective.',
}));

function setup() {
  const documents = new Map();
  const calls = [];
  const locks = new Map();
  let postcommitError = false;
  const key = ({ treeId, pathSegments }) => `${treeId}:${JSON.stringify(pathSegments)}`;
  const check = (options) => {
    calls.push(options);
    assert.equal(options.expireAfterInactivity, false);
    assert.deepEqual(options.pathSegments.slice(0, 3), ['Knowledge Trees', 'Quizzes', 'By Quiz ID']);
    assert.doesNotMatch(JSON.stringify(options.pathSegments), /Interactions|Conversations/);
  };
  globalThis.__quizRead = async (options) => {
    check(options);
    assert.equal(options.createIfMissing, false);
    return documents.get(key(options)) ?? null;
  };
  globalThis.__quizMutate = async (options) => {
    check(options);
    const id = key(options);
    const operation = (locks.get(id) ?? Promise.resolve()).then(() => {
      const current = documents.get(id) ?? null;
      if (!current && !options.createIfMissing) throw Object.assign(new Error('Not found'), { status: 404 });
      const next = options.mutate(current);
      documents.set(id, next.notes);
      if (postcommitError) { postcommitError = false; throw new Error('Connection lost after commit'); }
      return structuredClone(next.result);
    });
    locks.set(id, operation.catch(() => {}));
    return operation;
  };
  globalThis.__quizQuery = async () => ({ recordset: [] });
  return { documents, calls, failAfterCommit: () => { postcommitError = true; } };
}

async function active(count = 3, language = 'en') {
  const snapshot = source(count);
  let state = await repository.createPrepared(owner, snapshot, language);
  state = await repository.activate(owner, state.id, { version: state.version, title: 'Knowledge quiz', assessments: assessments(snapshot), questions: bank(snapshot).reverse() }, binding);
  return state;
}

async function presented(state, at = binding) {
  return repository.present(owner, state.id, { ...at, expectedVersion: state.version });
}

function submission(state, action = 'submit', submissionId = `submission-${state.questions.filter((q) => q.resolution).length + 1}`) {
  return {
    interactionId: state.id, workflow: 'quiz', version: state.version,
    stepId: currentQuizQuestion(state).id, action, submissionId,
    values: action === 'submit' ? { answer: 'Exact human answer' } : {},
  };
}

const grade = (state, outcome = 'correct', extra = {}) => ({
  version: state.version, questionId: currentQuizQuestion(state).id, outcome, feedback: 'Useful feedback.', ...extra,
});

test('preparing snapshots are durable, immutable copies with strict identity and raw source limits', async () => {
  const { documents, calls } = setup();
  const snapshot = source(1);
  const state = await repository.createPrepared(owner, snapshot);
  snapshot.leaves[0].notes = 'changed';
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.version, 0);
  assert.equal(state.status, 'preparing');
  assert.equal(state.title, 'Quiz');
  assert.equal(state.presentation, null);
  assert.deepEqual(quizProgress(state), {
    quizId: state.id, version: 0, status: 'preparing', total: 0, correct: 0, incorrect: 0, skipped: 0,
    answered: 0, remaining: 0, currentQuestionId: null, percentage: 0, provisional: true,
  });
  assert.throws(() => describeQuiz(state), { status: 409 });
  assert.equal((await repository.read(owner, state.id)).source.leaves[0].notes, 'Private notes 1');
  assert.equal(calls[0].createIfMissing, true);
  assert.equal(documents.size, 1);
  const resumed = await repository.resume(owner, state.id, human);
  assert.equal(resumed.status, 'preparing');
  assert.equal(resumed.version, 1);
  assert.equal(resumed.presentation, null);
  await assert.rejects(repository.present(owner, resumed.id, { ...binding, expectedVersion: resumed.version }), { status: 409 });
  for (const change of [
    (s) => { s.leaves = []; },
    (s) => { s.leaves = source(46).leaves; },
    (s) => { s.leaves[0].notes = 'x'.repeat(8001); },
    (s) => { s.leaves = source(13).leaves.map((leaf) => ({ ...leaf, notes: 'x'.repeat(8000) })); },
    (s) => { s.leaves[1].id = s.leaves[0].id; },
    (s) => { s.leaves[0].rootId = 'unknown-root'; },
    (s) => { delete s.leaves[0].revision; },
    (s) => { s.leaves[0].revision = 'not-a-revision'; },
    (s) => { s.fingerprint = 'not-a-fingerprint'; },
    (s) => { s.treeId = 42; },
  ]) {
    const invalid = source();
    change(invalid);
    await assert.rejects(repository.createPrepared(owner, invalid), { status: 400 });
  }
  const edge = source(13);
  edge.leaves.forEach((leaf, index) => { leaf.notes = 'x'.repeat(index === 12 ? 4000 : 8000); });
  await repository.createPrepared(owner, edge);
  await assert.rejects(repository.createPrepared(owner, source(), 'de'), { status: 400 });
});

test('forty-five frozen source leaves support a full bank and a stable smaller quiz across resume', async () => {
  for (const questionCount of [45, 25]) {
    setup();
    const snapshot = source(45);
    const initial = await repository.createPrepared(owner, snapshot);
    const state = await repository.activate(owner, initial.id, {
      version: initial.version, title: 'Sampled source quiz', questions: bank(snapshot),
      assessments: assessments(snapshot), questionCount,
    }, binding);
    assert.equal(state.source.leaves.length, 45);
    assert.equal(state.bank.length, 45);
    assert.equal(state.questions.length, questionCount);
    const resumed = await repository.resume(owner, state.id, human);
    assert.deepEqual(resumed.source, state.source);
    assert.deepEqual(resumed.questions, state.questions);
  }
});

test('new runs default to 25 from a full bank and restart can choose either size boundary without changing the bank', async () => {
  setup();
  const snapshot = source(45);
  const prepared = await repository.createPrepared(owner, snapshot, 'da');
  let state = await repository.activate(owner, prepared.id, {
    version: prepared.version, title: 'Full bank', questions: bank(snapshot), assessments: assessments(snapshot),
  }, binding);
  assert.equal(state.bank.length, 45);
  assert.equal(state.questionCount, 25);
  assert.equal(state.questions.length, 25);
  for (const questionCount of [1, 45, undefined]) {
    state = await repository.restart(owner, state.id, { version: state.version, questionCount }, binding);
    assert.equal(state.questionCount, questionCount ?? 25);
    assert.equal(state.questions.length, questionCount ?? 25);
    assert.deepEqual(state.bank, bank(snapshot));
    assert.deepEqual(state.source, snapshot);
    assert.equal(state.language, 'da');
    const resumed = await repository.resume(owner, state.id, human);
    assert.deepEqual(resumed.questions, state.questions);
    assert.equal(resumed.questionCount, state.questionCount);
    state = resumed;
  }
  for (const questionCount of [0, 46, 2.5, null]) {
    await assert.rejects(repository.restart(owner, state.id, { version: state.version, questionCount }, binding), { status: 400 });
    assert.deepEqual(await repository.read(owner, state.id), state);
  }
});

test('default and larger requested runs use the available supported bank without padding', async () => {
  setup();
  const initial = await active(3);
  assert.equal(initial.questionCount, 25);
  assert.equal(initial.questions.length, 3);
  const restarted = await repository.restart(owner, initial.id, { version: initial.version, questionCount: 45 }, binding);
  assert.equal(restarted.questionCount, 45);
  assert.equal(restarted.questions.length, 3);
  assert.deepEqual(restarted.bank, initial.bank);
  assert.equal(quizProgress(restarted).total, 3);
});

test('activation requires exact one-per-leaf coverage, stable source ordering and frozen bank', async () => {
  setup();
  const snapshot = source();
  const initial = await repository.createPrepared(owner, snapshot);
  for (const questions of [
    bank(snapshot).slice(1),
    [...bank(snapshot), bank(snapshot)[0]],
    bank(snapshot).map((question) => ({ ...question, leafId: 'unknown' })),
    bank(snapshot).map((question) => ({ ...question, leafId: 'leaf-1' })),
    bank(snapshot).map((question) => ({ ...question, question: ' ' })),
    bank(snapshot).map((question) => ({ ...question, referenceAnswer: 'x'.repeat(8001) })),
    bank(snapshot).map((question) => ({ ...question, gradingCriteria: 'x'.repeat(4001) })),
  ]) {
    await assert.rejects(repository.activate(owner, initial.id, { version: 0, title: 'Quiz', assessments: assessments(snapshot), questions }, binding), { status: 400 });
  }
  const state = await repository.activate(owner, initial.id, { version: 0, title: 'Quiz', assessments: assessments(snapshot), questions: bank(snapshot).reverse() }, binding);
  assert.equal(state.version, 1);
  assert.equal(state.presentation, null);
  assert.deepEqual(state.questions.map((q) => [q.id, q.leafId]), [['question-1', 'leaf-1'], ['question-2', 'leaf-2'], ['question-3', 'leaf-3']]);
  await assert.rejects(repository.activate(owner, state.id, { version: state.version, title: 'Changed', questions: bank(snapshot) }, binding), { status: 409 });
  assert.equal((await repository.read(owner, state.id)).title, 'Quiz');
});

test('a 45-question bank supports a frozen randomized 25-question coverage-first quiz and smaller requests', async () => {
  setup();
  const snapshot = source();
  const questions = Array.from({ length: 45 }, (_, index) => ({
    ...bank(snapshot)[index % 3], question: `Distinct question ${index}?`, learningObjective: `Objective ${index}`,
  }));
  const analysis = assessments(snapshot).map((item) => ({ ...item, questionCount: 15 }));
  const initial = await repository.createPrepared(owner, snapshot);
  await assert.rejects(repository.activate(owner, initial.id, {
    version: 0, title: 'Too many', questions: [...questions, { ...questions[0], question: 'Extra?', learningObjective: 'Extra' }],
    assessments: analysis.map((item, index) => ({ ...item, questionCount: index ? 15 : 16 })),
  }, binding), { status: 400 });
  for (const questionCount of [0, 46, 2.5]) {
    await assert.rejects(repository.activate(owner, initial.id, {
      version: 0, title: 'Invalid size', questions, assessments: analysis, questionCount,
    }, binding), { status: 400 });
  }
  const selected = await repository.activate(owner, initial.id, {
    version: 0, title: 'Sampled quiz', questions, assessments: analysis, questionCount: 25,
  }, binding);
  assert.equal(selected.bank.length, 45);
  assert.equal(selected.questions.length, 25);
  assert.equal(new Set(selected.questions.map((item) => item.learningObjective)).size, 25);
  assert.equal(new Set(selected.questions.slice(0, 3).map((item) => item.leafId)).size, 3);
  const resumed = await repository.resume(owner, selected.id, human);
  assert.deepEqual(resumed.questions, selected.questions);
  assert.deepEqual(resumed.bank, selected.bank);
  const another = await repository.createPrepared(owner, snapshot);
  const short = await repository.activate(owner, another.id, {
    version: 0, title: 'Short quiz', questions, assessments: analysis, questionCount: 2,
  }, binding);
  assert.equal(short.questions.length, 2);
  assert.equal(new Set(short.questions.map((item) => item.leafId)).size, 2);
});

test('restart replaces the run, resamples the default size and invalidates previous answers without archiving', async (t) => {
  const memory = setup();
  let useLastIndex = false;
  const random = t.mock.method(crypto, 'randomInt', (maximum) => useLastIndex ? maximum - 1 : 0);
  syncBuiltinESMExports();
  t.after(() => { random.mock.restore(); syncBuiltinESMExports(); });
  const snapshot = source();
  const questions = Array.from({ length: 45 }, (_, index) => ({
    ...bank(snapshot)[index % 3], question: `Question ${index}?`, learningObjective: `Objective ${index}`,
  }));
  const initial = await repository.createPrepared(owner, snapshot);
  let state = await repository.activate(owner, initial.id, {
    version: 0, title: 'Reusable bank', questions, questionCount: 25,
    assessments: assessments(snapshot).map((item) => ({ ...item, questionCount: 15 })),
  }, binding);
  const firstSelection = state.questions.map((question) => question.learningObjective);
  state = await presented(state);
  state = await repository.capture(owner, submission(state), human);
  state = await repository.resolve(owner, state.id, grade(state), human);
  state = await presented(state, { ...binding, turnId: 'clarification-shown' });
  const clarificationBinding = { ...human, turnId: 'clarification-input' };
  state = await repository.capture(owner, submission(state, 'submit', 'clarification-submission'), clarificationBinding);
  state = await repository.clarify(owner, state.id, {
    version: state.version, questionId: currentQuizQuestion(state).id, feedback: 'Please restate your answer.',
  }, clarificationBinding);
  state = await presented(state, { ...binding, turnId: 'pending-shown' });
  const pendingBinding = { ...human, turnId: 'pending-input' };
  const oldInput = submission(state, 'submit', 'pending-submission');
  state = await repository.capture(owner, oldInput, pendingBinding);
  const oldGrade = grade(state);
  const before = structuredClone(state);
  useLastIndex = true;
  const restarted = await repository.restart(owner, state.id, { version: state.version }, {
    ...binding, turnId: 'restart-turn',
  });
  assert.equal(restarted.id, before.id);
  assert.equal(restarted.version, before.version + 1);
  assert.equal(restarted.questionCount, 25);
  assert.equal(restarted.questions.length, 25);
  assert.notDeepEqual(restarted.questions.map((question) => question.learningObjective), firstSelection);
  assert.equal(new Set(restarted.questions.slice(0, 3).map((question) => question.leafId)).size, 3);
  for (const key of ['source', 'bank', 'assessments', 'title', 'createdAt']) assert.deepEqual(restarted[key], before[key]);
  for (const key of ['pending', 'clarification', 'lastSubmissionId', 'presentation']) assert.equal(restarted[key], null);
  assert.ok(restarted.questions.every((question) => question.resolution === null));
  assert.equal(quizProgress(restarted).answered, 0);
  assert.equal(quizProgress(restarted).remaining, 25);
  assert.deepEqual(quizResults(restarted).outcomes, []);
  assert.equal(describeQuiz(restarted).review, undefined);
  assert.equal(memory.documents.size, 1, 'No attempt archive or replacement quiz record is created');
  await assert.rejects(repository.capture(owner, oldInput, pendingBinding), { status: 409 });
  await assert.rejects(repository.resolve(owner, restarted.id, oldGrade, pendingBinding), { status: 409 });
  await assert.rejects(repository.restart(owner, restarted.id, { version: before.version }, binding), { status: 409 });
  const resumed = await repository.resume(owner, restarted.id, human);
  assert.deepEqual(resumed.questions, restarted.questions);
});

test('completed quizzes can restart, preparing quizzes cannot, and a committed restart is recovered without another draw', async () => {
  const memory = setup();
  const prepared = await repository.createPrepared(owner, source(1));
  await assert.rejects(repository.restart(owner, prepared.id, { version: 0 }, binding), { status: 409 });
  let state = await presented(await active(1));
  state = await repository.capture(owner, submission(state), human);
  state = await repository.resolve(owner, state.id, grade(state), human);
  assert.equal(state.status, 'completed');
  const version = state.version;
  memory.failAfterCommit();
  await assert.rejects(repository.restart(owner, state.id, { version }, binding), /after commit/);
  await assert.rejects(repository.restart(owner, state.id, { version }, binding), { status: 409 });
  const restarted = await repository.read(owner, state.id);
  assert.equal(restarted.status, 'active');
  assert.equal(quizProgress(restarted).correct, 0);
  assert.equal(restarted.questions[0].resolution, null);
  const resumed = await repository.resume(owner, state.id, human);
  assert.deepEqual(resumed.questions, restarted.questions);
  await assert.rejects(repository.restart({ ...owner, userId: 'other' }, state.id, { version: resumed.version }, binding), { status: 404 });
  await assert.rejects(repository.restart({ ...owner, app: 'other' }, state.id, { version: resumed.version }, binding), { status: 404 });
});

test('preparing quizzes persist unresolved language choices and cannot activate or change a selected language incorrectly', async () => {
  setup();
  const snapshot = source(1);
  let state = await repository.createPrepared(owner, snapshot, null);
  assert.equal(state.language, null);
  state = await repository.configurePrepared(owner, state.id, {
    version: state.version, language: 'und', questionCount: 1,
  }, binding);
  const activation = {
    version: state.version, title: 'Source-language quiz', questions: bank(snapshot), assessments: assessments(snapshot),
  };
  await assert.rejects(repository.activate(owner, state.id, activation, binding), { status: 409 });
  const unresolvedVersion = state.version;
  state = await repository.configurePrepared(owner, state.id, {
    version: state.version, language: 'da', questionCount: 1,
  }, binding);
  await assert.rejects(repository.configurePrepared(owner, state.id, {
    version: unresolvedVersion, language: 'en', questionCount: 1,
  }, binding), { status: 409 });
  await assert.rejects(repository.configurePrepared(owner, state.id, {
    version: state.version, language: 'en', questionCount: 1,
  }, binding), { status: 409 });
  await assert.rejects(repository.activate(owner, state.id, {
    ...activation, version: state.version, language: 'en',
  }, binding), { status: 409 });
  state = await repository.activate(owner, state.id, {
    ...activation, version: state.version, language: 'da',
  }, binding);
  assert.equal(state.language, 'da');
  assert.equal((await repository.read(owner, state.id)).language, 'da');
});

test('closed question types use the actual card fields and cannot accept a forged score', async () => {
  for (const [type, answer, expected] of [
    ['single_choice', 'option-2', 'correct'],
    ['single_choice', 'option-1', 'incorrect'],
    ['multiple_choice', ['option-2', 'option-1'], 'correct'],
    ['multiple_choice', ['option-1'], 'incorrect'],
    ['multiple_choice', ['option-1', 'option-2', 'option-3'], 'incorrect'],
    ['yes_no', 'no', 'correct'],
    ['yes_no', 'yes', 'incorrect'],
  ]) {
    setup();
    const snapshot = source(1);
    const item = {
      ...bank(snapshot)[0], type,
      options: type === 'yes_no' ? [] : ['Alpha', 'Beta', 'Gamma'].map((label, index) => ({ id: `option-${index + 1}`, label })),
      correctOptionIds: type === 'yes_no' ? ['no'] : type === 'single_choice' ? ['option-2'] : ['option-1', 'option-2'],
      optionExplanations: (type === 'yes_no' ? ['yes', 'no'] : ['option-1', 'option-2', 'option-3']).map((optionId) => ({
        optionId, explanation: `Evidence explaining ${optionId}.`,
      })),
    };
    let state = await repository.createPrepared(owner, snapshot);
    state = await repository.activate(owner, state.id, {
      version: 0, title: 'Typed quiz', questions: [item],
      assessments: [{ ...assessments(snapshot)[0], supportedTypes: [type] }],
    }, binding);
    state = await presented(state);
    assert.equal(describeQuiz(state).fields[0].type, type);
    assert.doesNotMatch(JSON.stringify(describeQuiz(state)), /Evidence explaining|optionExplanations|isCorrect/);
    state = await repository.capture(owner, { ...submission(state), values: { answer } }, human);
    await assert.rejects(repository.resolve(owner, state.id, grade(state, expected === 'correct' ? 'incorrect' : 'correct'), human), { status: 409 });
    state = await repository.resolve(owner, state.id, grade(state, expected), human);
    assert.deepEqual(quizResults(state).outcomes[0].answer, answer);
    assert.equal(quizResults(state).outcomes[0].answerText.includes('option-'), false);
    const explanations = quizResults(state).outcomes[0].optionExplanations;
    assert.equal(explanations.length, type === 'yes_no' ? 2 : 3);
    assert.deepEqual(explanations.map((option) => option.isCorrect), explanations.map((option) => item.correctOptionIds.includes(option.optionId)));
    assert.equal(describeQuiz(state).review.items.length, explanations.length);
    const resumed = await repository.resume(owner, state.id, human);
    assert.deepEqual(describeQuiz(resumed).review, describeQuiz(state).review);
  }
});

test('review correctness labels are not repeated by saved explanation prefixes', async () => {
  for (const [language, reasons, expected] of [
    ['en', ['Incorrect. The note contradicts this.', 'Correct: The note supports this.', 'This location lacks cover.'], [
      'Alpha - Incorrect: The note contradicts this.',
      'Beta - Correct: The note supports this.',
      'Gamma - Incorrect: This location lacks cover.',
    ]],
    ['da', ['Forkert. Noten modsiger dette.', 'Korrekt: Noten understotter dette.', 'Ikke korrekt. Her mangler skjul.'], [
      'Alpha - Forkert: Noten modsiger dette.',
      'Beta - Korrekt: Noten understotter dette.',
      'Gamma - Forkert: Her mangler skjul.',
    ]],
    ['en', ['  incorrect: The note contradicts this.', 'CORRECT. The note supports this.', 'Incorrect.'], [
      'Alpha - Incorrect: The note contradicts this.',
      'Beta - Correct: The note supports this.',
      'Gamma - Incorrect.',
    ]],
    ['en', ['Incorrect assumptions omit cover.', 'Correct placement depends on cover.', 'Correct. A conflicting label must remain visible.'], [
      'Alpha - Incorrect: Incorrect assumptions omit cover.',
      'Beta - Correct: Correct placement depends on cover.',
      'Gamma - Incorrect: Correct. A conflicting label must remain visible.',
    ]],
  ]) {
    setup();
    const snapshot = source(1);
    const item = {
      ...bank(snapshot)[0], type: 'single_choice', correctOptionIds: ['option-2'],
      options: ['Alpha', 'Beta', 'Gamma'].map((label, index) => ({ id: `option-${index + 1}`, label })),
      optionExplanations: reasons.map((explanation, index) => ({ optionId: `option-${index + 1}`, explanation })),
    };
    let state = await repository.createPrepared(owner, snapshot, language);
    state = await repository.activate(owner, state.id, {
      version: 0, title: 'Review formatting', questions: [item],
      assessments: [{ ...assessments(snapshot)[0], supportedTypes: ['single_choice'] }],
    }, binding);
    state = await presented(state);
    state = await repository.capture(owner, { ...submission(state), values: { answer: 'option-2' } }, human);
    state = await repository.resolve(owner, state.id, grade(state, 'correct'), human);
    assert.deepEqual(describeQuiz(state).review.items.map((entry) => entry.text), expected);
    assert.deepEqual(state.bank[0].optionExplanations, item.optionExplanations, 'Display formatting must not rewrite the saved bank');
    const resumed = await repository.resume(owner, state.id, human);
    assert.deepEqual(describeQuiz(resumed).review.items.map((entry) => entry.text), expected);
  }
});

test('answer and reveal reviews expose only resolved choices, never explanations for the next question', async () => {
  for (const action of ['submit', 'reveal']) {
    setup();
    const snapshot = source(2);
    const questions = bank(snapshot).map((question, index) => ({
      ...question, type: 'single_choice', correctOptionIds: ['option-2'],
      options: ['Alpha', 'Beta', 'Gamma'].map((label, at) => ({ id: `option-${at + 1}`, label })),
      optionExplanations: ['option-1', 'option-2', 'option-3'].map((optionId) => ({
        optionId, explanation: `PRIVATE_REASON_${index + 1}_${optionId}`,
      })),
    }));
    let state = await repository.createPrepared(owner, snapshot);
    state = await repository.activate(owner, state.id, {
      version: 0, title: 'Review coverage', questions,
      assessments: assessments(snapshot).map((item) => ({ ...item, supportedTypes: ['single_choice'] })),
    }, binding);
    state = await presented(state);
    assert.doesNotMatch(JSON.stringify([describeQuiz(state), quizResults(state)]), /PRIVATE_REASON/);
    const input = submission(state, action);
    input.values = action === 'submit' ? { answer: 'option-2' } : {};
    state = await repository.capture(owner, input, human);
    assert.doesNotMatch(JSON.stringify([describeQuiz(state), quizResults(state)]), /PRIVATE_REASON/);
    state = await repository.resolve(owner, state.id, grade(state, action === 'submit' ? 'correct' : 'skipped'), human);
    const card = describeQuiz(state);
    assert.equal(card.stepId, 'question-2');
    assert.equal(card.review.details[0], questions[0].question);
    assert.equal(card.review.items.length, 3);
    assert.match(JSON.stringify([card, quizResults(state)]), /PRIVATE_REASON_1/);
    assert.doesNotMatch(JSON.stringify([card, quizResults(state)]), /PRIVATE_REASON_2/);
    state = await repository.resume(owner, state.id, { ...human, conversationId: 'review-recovery' });
    assert.deepEqual(describeQuiz(state).review, card.review);
  }
});

test('free-answer clarification is unscored, durable and requires a later complete human resubmission', async () => {
  const { documents } = setup();
  let state = await presented(await active(1));
  state = await repository.capture(owner, submission(state, 'submit', 'unclear-attempt'), human);
  const clarify = { version: state.version, questionId: 'question-1', feedback: 'Please restate your complete answer.' };
  await assert.rejects(repository.clarify(owner, state.id, { ...clarify, feedback: ' ' }, human), { status: 409 });
  state = await repository.clarify(owner, state.id, clarify, human);
  assert.equal(state.pending, null);
  assert.equal(state.questions[0].resolution, null);
  assert.equal(quizProgress(state).answered, 0);
  assert.equal(quizProgress(state).remaining, 1);
  assert.match(describeQuiz(state).prompt, /Please restate/);
  assert.equal(describeQuiz(state).values.answer, 'Exact human answer');
  const corrupt = structuredClone(state);
  corrupt.clarification.answer = '';
  documents.set(documents.keys().next().value, JSON.stringify(corrupt));
  await assert.rejects(repository.read(owner, state.id), { status: 409 });
  documents.set(documents.keys().next().value, JSON.stringify(state));
  state = await repository.resume(owner, state.id, { ...human, conversationId: 'fresh-clarification' });
  const at = { conversationId: 'fresh-clarification', turnId: 'clarification-shown' };
  state = await presented(state, at);
  await assert.rejects(repository.capture(owner, submission(state, 'submit', 'unclear-attempt'), { ...at, turnId: 'later' }), { status: 409 });
  await assert.rejects(repository.capture(owner, submission(state, 'submit', 'new-attempt'), at), { status: 409 });
  state = await repository.capture(owner, {
    ...submission(state, 'submit', 'new-attempt'), values: { answer: 'My complete restated answer.' },
  }, { ...at, turnId: 'later' });
  state = await repository.resolve(owner, state.id, grade(state), { ...at, turnId: 'later' });
  assert.equal(state.clarification, null);
  assert.equal(state.questions[0].resolution.answer, 'My complete restated answer.');
  assert.equal(quizProgress(state).answered, 1);
});

test('correct, incorrect and reveal outcomes are server-derived with spoiler-free cards and results', async () => {
  setup();
  let state = await active();
  for (const [index, outcome] of ['correct', 'incorrect', 'skipped'].entries()) {
    const at = { ...binding, turnId: `presentation-${index}` };
    const reply = { ...human, turnId: `answer-${index}` };
    state = await presented(state, at);
    const card = describeQuiz(state);
    assert.equal(card.workflow, 'quiz');
    assert.deepEqual(card.allowedActions, ['submit', 'reveal']);
    assert.deepEqual(card.values, { answer: '' });
    assert.equal(card.progress.current, index + 1);
    assert.doesNotMatch(JSON.stringify(card), /SECRET|referenceAnswer|gradingCriteria|Private notes/);
    state = await repository.capture(owner, submission(state, outcome === 'skipped' ? 'reveal' : 'submit'), reply);
    assert.equal(describeQuiz(state).status, 'pending');
    assert.deepEqual(describeQuiz(state).allowedActions, ['resume']);
    state = await repository.resolve(owner, state.id, grade(state, outcome), reply);
  }
  assert.deepEqual(quizProgress(state), {
    quizId: state.id, version: state.version, status: 'completed', total: 3, correct: 1, incorrect: 1, skipped: 1,
    answered: 2, remaining: 0, currentQuestionId: null, percentage: 100 / 3, provisional: false,
  });
  const results = quizResults(state);
  assert.deepEqual(results.outcomes.map((item) => item.answer), ['Exact human answer', 'Exact human answer', null]);
  assert.doesNotMatch(JSON.stringify(results), /SECRET|referenceAnswer|gradingCriteria|Private notes/);
  const card = describeQuiz(state);
  assert.equal(card.prompt, state.questions.at(-1).prompt);
  assert.equal(card.stepId, 'question-3');
  assert.deepEqual(card.values, { answer: '' });
  assert.deepEqual(card.allowedActions, []);
});

test('completed answer context and Danish server counts are preserved', async () => {
  setup();
  let state = await presented(await active(1, 'da'));
  state = await repository.capture(owner, submission(state), human);
  state = await repository.resolve(owner, state.id, grade(state), human);
  const card = describeQuiz(state);
  assert.equal(card.fields[0].label, 'Dit svar');
  assert.equal(card.values.answer, 'Exact human answer');
  assert.match(card.summary, /1 korrekte/);
  assert.equal(quizProgress(state).percentage, 100);
});

test('reading solutions never changes or scores state; scoring requires captured earlier-turn presented input', async () => {
  setup();
  let state = await active(1);
  const original = structuredClone(state);
  assert.match((await repository.read(owner, state.id)).questions[0].referenceAnswer, /SECRET/);
  assert.deepEqual(await repository.read(owner, state.id), original);
  await assert.rejects(repository.resolve(owner, state.id, grade(state), human), { status: 409 });
  await assert.rejects(repository.capture(owner, submission(state), human), { status: 409 });
  state = await presented(state);
  await assert.rejects(repository.capture(owner, submission(state), binding), { status: 409 });
  await assert.rejects(repository.capture(owner, submission(state), { ...human, conversationId: 'other-conversation' }), { status: 409 });
  await assert.rejects(repository.capture(owner, { ...submission(state), values: { answer: 'x'.repeat(2001) } }, human), { status: 400 });
  await assert.rejects(repository.capture(owner, { ...submission(state), values: { answer: 'ok', forged: 'x' } }, human), { status: 400 });
  await assert.rejects(repository.capture(owner, { ...submission(state), stepId: 'question-2' }, human), { status: 409 });
  await assert.rejects(repository.capture(owner, { ...submission(state), action: 'reveal', values: { answer: 'forged' } }, human), { status: 400 });
  await assert.rejects(repository.capture(owner, { ...submission(state), action: 'back', values: {} }, human), { status: 409 });
});

test('locked capture rejects stale, duplicate and concurrent submissions', async () => {
  setup();
  let state = await presented(await active());
  const input = submission(state);
  const captures = await Promise.allSettled([
    repository.capture(owner, input, human),
    repository.capture(owner, { ...input, submissionId: 'concurrent' }, human),
  ]);
  assert.equal(captures.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(captures.find((item) => item.status === 'rejected').reason.status, 409);
  state = await repository.read(owner, state.id);
  await assert.rejects(repository.capture(owner, input, human), { status: 409 });
  state = await repository.resolve(owner, state.id, grade(state), human);
  state = await presented(state, { ...binding, turnId: 'next-question' });
  await assert.rejects(repository.capture(owner, { ...submission(state), submissionId: input.submissionId }, human), { status: 409 });
});

test('resolution binds exact question, version, action and grading turn; rejects invented answer/counts and retries', async () => {
  setup();
  let state = await presented(await active(2));
  state = await repository.capture(owner, submission(state), human);
  for (const input of [
    grade(state, 'correct', { version: state.version - 1 }),
    grade(state, 'correct', { questionId: 'question-2' }),
    grade(state, 'skipped'),
    grade(state, 'correct', { answer: 'invented' }),
    grade(state, 'correct', { correct: 99 }),
  ]) await assert.rejects(repository.resolve(owner, state.id, input, human), { status: 409 });
  await assert.rejects(repository.resolve(owner, state.id, grade(state), { ...human, turnId: 'wrong-turn' }), { status: 409 });
  await assert.rejects(repository.resolve(owner, state.id, grade(state), { ...human, conversationId: 'wrong-conversation' }), { status: 409 });
  await assert.rejects(repository.resolve(owner, state.id, grade(state, 'correct', { feedback: ' ' }), human), { status: 400 });
  await assert.rejects(repository.resolve(owner, state.id, grade(state, 'correct', { feedback: 'x'.repeat(4001) }), human), { status: 400 });
  const command = grade(state);
  const outcomes = await Promise.allSettled([
    repository.resolve(owner, state.id, command, human),
    repository.resolve(owner, state.id, { ...command, outcome: 'incorrect' }, human),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((item) => item.status === 'rejected').reason.status, 409);
  state = await repository.read(owner, state.id);
  assert.equal(quizProgress(state).correct, 1);
  await assert.rejects(repository.resolve(owner, state.id, command, human), { status: 409 });
  state = await presented(state, { ...binding, turnId: 'show-second' });
  state = await repository.capture(owner, submission(state, 'reveal'), human);
  await assert.rejects(repository.resolve(owner, state.id, grade(state), human), { status: 409 });
});

test('resume rebinds pending authority without losing capture provenance or marking a presentation', async () => {
  setup();
  let state = await presented(await active(2));
  state = await repository.capture(owner, submission(state), human);
  const originalQuestions = structuredClone(state.questions);
  const resumedBinding = { conversationId: 'new-conversation', turnId: 'resume-turn' };
  const beforeVersion = state.version;
  state = await repository.resume(owner, state.id, resumedBinding);
  assert.equal(state.version, beforeVersion + 1);
  assert.equal(state.presentation, null);
  assert.equal(state.pending.conversationId, resumedBinding.conversationId);
  assert.deepEqual(state.questions, originalQuestions);
  await assert.rejects(repository.resolve(owner, state.id, grade(state), human), { status: 409 });
  state = await repository.resolve(owner, state.id, grade(state), resumedBinding);
  assert.equal(state.questions[0].resolution.conversationId, human.conversationId);
  assert.equal(state.questions[0].resolution.turnId, human.turnId);
  const progress = quizProgress(state);
  const version = state.version;
  state = await repository.resume(owner, state.id, resumedBinding);
  assert.equal(state.version, version + 1);
  assert.equal(state.presentation, null);
  assert.equal(quizProgress(state).correct, progress.correct);
  await assert.rejects(repository.capture(owner, submission(state), { ...resumedBinding, turnId: 'later' }), { status: 409 });
});

test('postcommit connection failure recovers by durable read/resume without rescoring', async () => {
  const memory = setup();
  let state = await presented(await active(1));
  state = await repository.capture(owner, submission(state), human);
  const command = grade(state);
  memory.failAfterCommit();
  await assert.rejects(repository.resolve(owner, state.id, command, human), /after commit/);
  await assert.rejects(repository.resolve(owner, state.id, command, human), { status: 409 });
  state = await repository.read(owner, state.id);
  assert.equal(state.status, 'completed');
  assert.equal(quizProgress(state).correct, 1);
  state = await repository.resume(owner, state.id, { conversationId: 'recovery', turnId: 'recovery-turn' });
  assert.equal(quizProgress(state).correct, 1);
  assert.equal(state.presentation, null);
});

test('a capture committed before a connection failure is resumed rather than replaced or fabricated', async () => {
  const memory = setup();
  let state = await presented(await active(1));
  const input = submission(state);
  memory.failAfterCommit();
  await assert.rejects(repository.capture(owner, input, human), /after commit/);
  await assert.rejects(repository.capture(owner, input, human), { status: 409 });
  state = await repository.read(owner, state.id);
  assert.equal(quizProgress(state).correct, 0);
  assert.equal(state.pending.values.answer, 'Exact human answer');
  const recovery = { conversationId: 'another-conversation', turnId: 'recovery-turn' };
  await assert.rejects(repository.resolve(owner, state.id, grade(state), recovery), { status: 409 });
  state = await repository.resume(owner, state.id, recovery);
  state = await repository.resolve(owner, state.id, grade(state), recovery);
  assert.equal(state.questions[0].resolution.answer, 'Exact human answer');
  assert.equal(state.questions[0].resolution.submissionId, input.submissionId);
  assert.equal(quizProgress(state).correct, 1);
});

test('owner/application boundaries, presentation version guards and corrupt documents fail closed', async () => {
  const { documents, calls } = setup();
  let state = await active(1);
  await assert.rejects(repository.read({ ...owner, userId: 'other' }, state.id), { status: 404 });
  await assert.rejects(repository.read({ ...owner, app: 'other' }, state.id), { status: 404 });
  await assert.rejects(repository.read(null, state.id), /Authentication/);
  await assert.rejects(repository.present(owner, state.id, { ...binding, expectedVersion: 999 }), { status: 409 });
  state = await presented(state);
  assert.equal(state.presentation.version, state.version);
  assert.equal(state.presentation.stepId, 'question-1');
  assert.ok(calls.slice(1).every((call) => call.createIfMissing === false));
  for (const change of [
    (s) => { delete s.lastSubmissionId; },
    (s) => { s.version = -1; },
    (s) => { s.id = 'different-id'; },
    (s) => { s.questions[0].resolution = undefined; },
    (s) => { s.questions[0].referenceAnswer = ''; },
    (s) => { s.questions[0].leafId = 'wrong-leaf'; },
    (s) => { s.source.leaves[0].revision = 123; },
    (s) => { s.presentation = {}; },
  ]) {
    const corrupt = structuredClone(state);
    change(corrupt);
    documents.set(documents.keys().next().value, JSON.stringify(corrupt));
    await assert.rejects(repository.read(owner, state.id), { status: 409 });
  }
  documents.set(documents.keys().next().value, '{bad');
  await assert.rejects(repository.read(owner, state.id), { status: 409 });
  assert.throws(() => validateQuizState({}), { status: 409 });
});

test('listing is bounded SQL pagination with exact durable path and owner/application scoping, without spoilers', async () => {
  setup();
  const preparing = await repository.createPrepared(owner, source(1));
  const state = await active(1);
  let request;
  globalThis.__quizQuery = async (options) => {
    request = options;
    return { recordset: [preparing, state].map((item) => ({ quizId: item.id, notes: JSON.stringify(item) })) };
  };
  const page = await repository.list(owner, { offset: 5, limit: 1 });
  assert.equal(page.quizzes.length, 1);
  assert.equal(page.quizzes[0].status, 'preparing');
  assert.equal(page.nextOffset, 6);
  assert.equal(page.offset, 5);
  assert.equal(page.quizzes[0].treeId, preparing.source.treeId);
  assert.deepEqual(page.quizzes[0].rootIds, preparing.source.rootIds);
  assert.equal(page.quizzes[0].availableQuestions, 0);
  assert.equal(page.quizzes[0].requestedQuestionCount, preparing.questionCount);
  assert.doesNotMatch(JSON.stringify(page), /SECRET|referenceAnswer|gradingCriteria|Private notes|source/);
  assert.deepEqual(request.inputs, { tree_id: 7, owner: 'owner', application_identifier: 'app-a', offset: 5, page_size: 2 });
  assert.match(request.query, /OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY/);
  assert.match(request.query, /tree\.owner_object_id = @owner AND app\.app_identifier = @application_identifier/);
  assert.match(request.query, /tree\.deleted_at IS NULL AND tree\.is_private = 1/);
  assert.match(request.query, /knowledge\.parent_id IS NULL AND knowledge\.text = N'Knowledge Trees'/);
  assert.match(request.query, /quizzes\.text = N'Quizzes'/);
  assert.match(request.query, /by_id\.text = N'By Quiz ID'/);
  assert.match(request.query, /ISJSON\(details\.notes\) = 1/);
  assert.match(request.query, /'\$\.schemaVersion'\) = N'3'/);
  assert.match(request.query, /'\$\.id'\) = quiz\.text/);
  assert.match(request.query, /ORDER BY details\.updated_at DESC, quiz\.id DESC/);
  assert.match(request.query, /files\.tree_node_id = quiz\.id/);
  assert.doesNotMatch(request.query, /DATEADD|expire|Interactions|Conversations/);
  globalThis.__quizQuery = async () => ({ recordset: [] });
  assert.deepEqual(await repository.list(owner), { quizzes: [], offset: 0, nextOffset: null });
  for (const options of [{ limit: 0 }, { limit: 21 }, { offset: -1 }, { offset: 0.1 }, { offset: 2147483648 }, { limit: 1.5 }]) {
    await assert.rejects(repository.list(owner, options), { status: 400 });
  }
  await assert.rejects(repository.list(null), /Authentication/);
  globalThis.__quizQuery = async () => { throw new Error('Database unavailable'); };
  await assert.rejects(repository.list(owner), /Database unavailable/);
});
