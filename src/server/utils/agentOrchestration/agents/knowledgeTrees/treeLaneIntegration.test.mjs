import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/quizModel.js')) {
      return {
        url: `data:text/javascript,${encodeURIComponent(`
          export const generateQuizBank = async (input) => {
            globalThis.__laneQuizPlanningCalls++;
            const language = input.language ?? globalThis.__laneQuizLanguage;
            await input.onLanguageSelected(language);
            if (language === 'und') return {
              requiresLanguageChoice: true, languageReason: 'No dominant source language.', supportedLanguages: ['en', 'da'],
            };
            return { ...await globalThis.__laneQuizGenerate({ ...input, language }), language };
          };
          export const gradeQuizFreeAnswer = (input) => globalThis.__laneQuizGrade(input);
        `)}`,
        shortCircuit: true,
      };
    }
    if (specifier.endsWith('/quizSources.js')) {
      return {
        url: `data:text/javascript,${encodeURIComponent(`
          export const listQuizTrees = (options) => globalThis.__laneQuizSources('trees', options);
          export const listQuizRoots = (options) => globalThis.__laneQuizSources('roots', options);
          export const prepareQuizSources = (options) => globalThis.__laneQuizSources('prepare', options);
          export const assertQuizSourceAccess = (options) => globalThis.__laneQuizSources('access', options);
        `)}`,
        shortCircuit: true,
      };
    }
    if (specifier.endsWith('/interactionLookupRepository.js')) {
      return {
        url: `data:text/javascript,${encodeURIComponent('export const findLatestActiveInteractionId = (options) => globalThis.__laneLookup(options);')}`,
        shortCircuit: true,
      };
    }
    if (specifier.endsWith('/interactionCleanupRepository.js')) {
      return {
        url: `data:text/javascript,${encodeURIComponent('export const cleanupInactiveInteractions = async () => {};')}`,
        shortCircuit: true,
      };
    }
    if (specifier.endsWith('/treeConversationCleanupRepository.js')) {
      return {
        url: `data:text/javascript,${encodeURIComponent('export const cleanupInactiveTreeConversations = async () => {};')}`,
        shortCircuit: true,
      };
    }
    const name = specifier.split('/').at(-1);
    const stubs = {
      logging: 'export const logStructuredTrace = async () => {};',
      foundryAgentClient: 'export const getProjectClient = () => { globalThis.__laneFoundry.push("client"); return { getOpenAIClient: () => globalThis.__laneClient }; };',
      personalCacheTreeRepository: `
        export const getPersonalCacheContext = async () => ({ personalCacheTreeId: 1, updatedBy: {} });
        export const findPersonalCacheLeafPathNode = () => globalThis.__laneFind();
        export const mutatePersonalCacheNotes = (options) => globalThis.__laneMutate(options);
        export const readPersonalCacheNotes = (options) => globalThis.__laneRead(options);`,
      treeCatalog: 'export const getTreeList = async () => [{ id: 1, currentUserCanWrite: true }]; export const assertTreeAccess = async () => { throw new Error("Unexpected access check in a tool-result builder"); }; export const getAuditMetadata = () => ({ updatedByObjectId: "owner" });',
      sql: `export const getRequiredApplicationIdentifier = () => 'app'; export const withSqlConnection = async (action) => action();
        export const sql = { Int: 'int', NVarChar: () => 'nvarchar', Request: class {
          input() { return this; } async query() { return { recordset: globalThis.__laneQuizRows ?? [] }; }
        } };`,
      treeAgentCatalog: `
        export const KNOWLEDGE_TREES_FAMILY = 'knowledgeTrees';
        export const getPublishedKnowledgeTreesPromptAgent = async () => { globalThis.__laneFoundry.push('agent'); return { id: 'agent', name: 'agent', version: '1' }; };
        export const buildRuntimeTreeToolContext = async (options) => { globalThis.__laneFoundry.push('tools'); return globalThis.__laneTools(options); };
        export const buildVisibilityScopeContext = () => ({ visibility: 'private' });
        export const buildVisibilityScopeInstruction = () => 'Private trees only';
        export const buildAllowedToolInstruction = () => 'search_tree_topics_1';`,
    };
    if (specifier.startsWith('@/') && stubs[name]) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs[name])}`, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const base = new URL(`../../../../../${specifier.slice(2)}`, import.meta.url);
      const file = new URL(`${base.href}.js`);
      return nextResolve(existsSync(file) ? file.href : new URL(`${base.href}/index.js`).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { invokeKnowledgeTreesAgent } = await import('./treeAgentService.js');
const { buildKnowledgeTreesFamilyResult } = await import('./treeAgentResultBuilder.js');
const { buildPersistenceToolHandlerResult } = await import('./tools/persistenceToolShared.js');
const { buildCollectionTestSpecification } = await import('./tools/collectStructuredInputTool/sampleSpecification.js');
const { quizToolDefinition } = await import('./lanes/quiz/tools/quizTool/toolDefinition.js');
const previewId = 'c125d350-4cae-4ad4-a69c-419324125e00';
const uploadId = '60b8daca-abcd-4321-8000-000000000001';
const path = 'Topics > Fish';
const noteLink = '[View note](/notes?treeId=1&nodeId=2)';
const note = 'Fish live in water.';
let context;
let history;
let calls;
let modelRequests;
let turnSequence;
let responses;
let expiredPaths;
let quizSourceChanged;
let quizAccessAllowed;

function final(answer, extra = {}) {
  return {
    id: `response-${Math.random()}`, output: [],
    output_text: JSON.stringify({
      answer, knowledgeMode: 'grounded', isPermissionToBroadenRequest: false,
      isPersistenceOffer: false, explanation: 'Reporting this turn.',
      persistenceAction: 'none', isWaitingForContinuation: false,
      responseLanguage: 'en', languageReason: 'The current message is English.', ...extra,
    }),
  };
}
function tool(name, args) {
  return { type: 'function_call', name, call_id: `call-${Math.random()}`, arguments: JSON.stringify(args) };
}
function tools(...output) {
  return { id: `tools-${Math.random()}`, output };
}
function quizSwitch() {
  return tool('switch_tree_lane', { activeLane: 'quiz', reason: 'The human requested a quiz or its resume.' });
}
function quizArgs(operation, values = {}) {
  return { ...Object.fromEntries(Object.keys(quizToolDefinition.parameters.properties).map((key) => [key, null])), operation, ...values };
}
async function savedQuiz(id = null) {
  if (!id) {
    const conversation = JSON.parse(await globalThis.__laneRead({
      pathSegments: ['Knowledge Trees', 'Conversations', 'State', context.conversationId],
    }));
    id = conversation.quizId;
  }
  return JSON.parse(await globalThis.__laneRead({ pathSegments: ['Knowledge Trees', 'Quizzes', 'By Quiz ID', id] }));
}
const quizBank = [
  { leafId: '11', question: 'Where do fish live?', referenceAnswer: 'Fish live in water.', gradingCriteria: 'Mentions water.' },
  { leafId: '12', question: 'What covers birds?', referenceAnswer: 'Birds have feathers.', gradingCriteria: 'Mentions feathers.' },
].map((question) => ({
  ...question, type: 'text', options: [], correctOptionIds: [], optionExplanations: [], learningObjective: question.question,
}));
async function createRealQuiz(questionCount = null) {
  const { result } = await submit('Quiz me about Animals.', [
    tools(quizSwitch(), tool('quiz', quizArgs('prepare', { treeId: '1', rootIds: ['10'] }))),
    async () => {
      const state = await savedQuiz();
      return tools(tool('quiz', quizArgs('create', {
        quizId: state.id, version: state.version, questionCount,
      })));
    },
    final('Answer the first question.'),
  ]);
  return result;
}

function quizSubmission(card, action, values = {}) {
  return { interactionSubmission: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version,
    workflow: 'quiz', submissionId: `quiz-input-${turnSequence + 1}`, action, values,
  } };
}

function currentQuizOperation(operation, extra = {}) {
  return async () => {
    const state = await savedQuiz();
    return tools(tool('quiz', quizArgs(operation, {
      quizId: state.id, version: state.version,
      questionId: state.questions.find((item) => !item.resolution).id, ...extra,
    })));
  };
}

function assessQuizAnswer(verdict, response = null) {
  return [
    async () => {
      const state = await savedQuiz();
      globalThis.__laneQuizGrade = async () => ({
        verdict, feedback: verdict === 'correct' ? 'Correct.' : 'That is not correct.',
      });
      return tools(tool('quiz', quizArgs('answer', {
        quizId: state.id, version: state.version, questionId: state.questions.find((item) => !item.resolution).id,
        response,
      })));
    },
    final('Feedback and the next saved question, or final results.'),
  ];
}
function setup() {
  const documents = new Map();
  const key = ({ pathSegments }) => JSON.stringify(pathSegments);
  expiredPaths = new Set();
  globalThis.__laneLookup = async () => {
    const match = [...documents.entries()].reverse().find(([path, notes]) => {
      const state = JSON.parse(notes);
      return path.includes('"Interactions"') && !expiredPaths.has(path) &&
        state.workflow === 'structured-input' && state.status === 'active';
    });
    return match ? JSON.parse(match[1]).id : null;
  };
  function assertNotExpired(options) {
    if (options.expireAfterInactivity && expiredPaths.has(key(options))) {
      throw Object.assign(new Error('Saved chat state expired after 24 hours of inactivity. Reload chat.'), {
        status: 410, code: 'CHAT_STATE_EXPIRED',
      });
    }
  }
  globalThis.__laneRead = async (options) => {
    assertNotExpired(options);
    return documents.get(key(options)) ?? null;
  };
  globalThis.__laneFind = () => documents.size ? { id: 1 } : null;
  context = { conversationId: 'integration-conversation', version: 0 };
  history = [];
  calls = { preview: 0, save: 0, search: 0, process: 0 };
  modelRequests = [];
  globalThis.__laneFoundry = [];
  globalThis.__laneQuizRows = [];
  globalThis.__laneQuizLanguage = 'en';
  globalThis.__laneQuizPlanningCalls = 0;
  globalThis.__laneQuizGenerate = async ({ source }) => ({
    title: 'Animals quiz', questions: structuredClone(quizBank),
    assessments: source.leaves.map((leaf) => ({
      leafId: leaf.id, supportedTypes: ['text'], questionCount: 1, reason: 'One supported fact.',
    })),
  });
  globalThis.__laneQuizGrade = async () => ({ verdict: 'correct', feedback: 'Correct.' });
  quizSourceChanged = false;
  quizAccessAllowed = true;
  globalThis.__laneQuizSources = async (operation, options) => {
    assert.ok(options.includedTrees.some((tree) => String(tree.id) === '1'));
    if (!quizAccessAllowed || options.treeId && String(options.treeId) !== '1') {
      throw Object.assign(new Error('Quiz source access denied'), { status: 403 });
    }
    if (operation === 'access') return '1';
    if (operation === 'trees') return {
      trees: [{ id: '1', optionId: 'tree-1', label: 'Animals', updatedAt: null }],
      total: 1, limitedToRecent: false,
    };
    if (operation === 'roots') return {
      treeId: '1', roots: [{ id: '10', optionId: 'root-10', label: 'Animals' }],
      total: 1, matching: 1, requiresNarrowing: false,
    };
    assert.deepEqual(options.rootIds, ['10']);
    return {
      treeId: '1', rootIds: ['10'], fingerprint: (quizSourceChanged ? 'b' : 'a').repeat(64),
      leaves: [
        { id: '11', rootId: '10', title: 'Fish', path: 'Animals > Fish', notes: 'Fish live in water.', revision: null },
        { id: '12', rootId: '10', title: 'Birds', path: 'Animals > Birds', notes: 'Birds have feathers.', revision: null },
      ],
      excludedLeaves: [],
    };
  };
  turnSequence = 0;
  globalThis.__laneMutate = async (options) => {
    assertNotExpired(options);
    const change = options.mutate(documents.get(key(options)) ?? null);
    documents.delete(key(options));
    documents.set(key(options), change.notes);
    return change.result;
  };
  globalThis.__laneClient = {
    responses: { create: async (request, configuration) => {
      modelRequests.push({ request, configuration });
      assert.ok(responses.length, 'Unexpected additional model call');
      const response = responses.shift();
      return typeof response === 'function' ? response() : response;
    } },
  };
  globalThis.__laneTools = ({ interactionRuntime }) => ({
    includedTrees: [{ id: 1, isPrivate: true }],
    toolPolicies: new Map(['search_tree_topics_1', 'preview_save_to_tree', 'revise_save_preview', 'confirm_save_to_tree', 'process_upload', 'collect_structured_input', 'quiz']
      .map((name) => [name, { requiresUserApproval: false }])),
    handlerMap: new Map([
      ['collect_structured_input', (args) => interactionRuntime.collect(args)],
      ['quiz', (args) => interactionRuntime.quiz(args)],
      ['search_tree_topics_1', async () => {
        calls.search++;
        return { count: 1, results: [{ treeId: 1, nodeId: 2, title: 'Fish' }] };
      }],
      ['preview_save_to_tree', async () => {
        calls.preview++;
        return buildPersistenceToolHandlerResult({
          toolName: 'preview_save_to_tree', toolResultType: 'tree_note_preview',
          toolOutput: { previewId, defaultSavePath: path },
        });
      }],
      ['confirm_save_to_tree', async () => {
        calls.save++;
        return buildPersistenceToolHandlerResult({
          toolName: 'confirm_save_to_tree', toolResultType: 'tree_note_created',
          toolOutput: { noteLink, details: { notes: note } },
        });
      }],
      ['revise_save_preview', async () => { throw new Error('Not expected in this scenario'); }],
      ['process_upload', async () => {
        calls.process++;
        return { toolResultType: 'temporary_upload_note', data: { uploadId, status: 'queued' } };
      }],
    ]),
  });
}
function options(message, extra) {
  return {
    principal: { userId: 'owner' }, message, history: structuredClone(history), visibility: 'private',
    language: 'en', conversationId: context.conversationId, expectedVersion: context.version,
    turnId: `turn-${++turnSequence}`, ...extra,
  };
}
async function submit(message, nextResponses, extra = {}) {
  responses = [...nextResponses];
  const request = options(message, extra);
  const result = await invokeKnowledgeTreesAgent(request);
  context = result.laneContext;
  history.push({ role: 'user', content: message }, { role: 'assistant', content: result.answer });
  assert.equal(responses.length, 0);
  return { request, result };
}

test('quiz invocation summaries parse JSON arguments and retain safe metadata without human answers', async () => {
  for (const serialize of [JSON.stringify, (value) => value]) {
    const args = quizArgs('answer', {
      quizId: 'quiz-id', setupId: 'setup-id', treeId: '1', rootIds: ['10'],
      questionId: 'question-1', version: 3, questionCount: 25, offset: 0,
      response: { action: 'submit', fields: [{ id: 'answer', value: 'PRIVATE_HUMAN_ANSWER', selections: null }] },
      revealRequest: 'PRIVATE_REVEAL_MESSAGE',
      restartRequest: 'PRIVATE_RESTART_MESSAGE',
    });
    const { familyResult } = await buildKnowledgeTreesFamilyResult({
      finalResponse: final('Reporting the quiz tool result.'),
      finalToolInvocations: [{ toolName: 'quiz', arguments: serialize(args), output: { count: 1 } }],
    });
    const summary = familyResult.familyPayload.responseToolInvocations[0];
    assert.deepEqual(summary.arguments, {
      operation: 'answer', quizId: 'quiz-id', setupId: 'setup-id', treeId: '1', rootIds: ['10'],
      version: 3, questionCount: 25, questionId: 'question-1', language: null, offset: 0,
    });
    assert.equal(summary.resultCount, 1);
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_|response|revealRequest|restartRequest/);
  }
});

test('malformed quiz arguments remain diagnosable without exposing raw input or breaking result shaping', async () => {
  for (const args of ['{"response":"PRIVATE_ANSWER"', 'null', '[]']) {
    const { familyResult } = await buildKnowledgeTreesFamilyResult({
      finalResponse: final('The tool rejected the call.'),
      finalToolInvocations: [{ toolName: 'quiz', arguments: args, output: { count: 0 } }],
    });
    const summary = familyResult.familyPayload.responseToolInvocations[0];
    assert.match(summary.arguments.argumentParseError, /Quiz tool arguments/);
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_ANSWER/);
  }
});

test('a rejected empty source selection still reports the prepare operation and selected root IDs', async () => {
  setup();
  const sourceProvider = globalThis.__laneQuizSources;
  const message = 'Selected roots contain no eligible leaves; select roots containing nonempty ordinary-note leaves.';
  globalThis.__laneQuizSources = async (operation, options) => {
    if (operation === 'prepare') throw Object.assign(new Error(message), { status: 400 });
    return sourceProvider(operation, options);
  };
  let generated = false;
  globalThis.__laneQuizGenerate = async () => { generated = true; throw new Error('Generation must not start'); };
  const { result } = await submit('Quiz me about this root.', [
    tools(quizSwitch(), tool('quiz', quizArgs('prepare', { treeId: '1', rootIds: ['10'] }))),
    final('The selected root has no eligible notes. Nothing was generated.'),
  ]);
  const invocation = result.familyPayload.responseToolInvocations.find((call) => call.toolName === 'quiz');
  assert.equal(invocation.arguments.operation, 'prepare');
  assert.equal(invocation.arguments.treeId, '1');
  assert.deepEqual(invocation.arguments.rootIds, ['10']);
  assert.equal(generated, false);
  assert.ok(JSON.stringify(modelRequests.at(-1).request.input).includes(message));
});

test('real quiz creation, card grading and textarea grading share cards and commit exact server progress', async () => {
  setup();
  const started = await createRealQuiz();
  assert.equal(started.interaction.workflow, 'quiz');
  assert.equal(started.interaction.stepId, 'question-1');
  assert.equal(started.interaction.prompt, 'Where do fish live?');
  assert.equal(started.quiz.total, 2);
  assert.equal(started.quiz.remaining, 2);
  assert.deepEqual(started.familyPayload.responseToolInvocations.filter((call) => call.toolName === 'quiz')
    .map((call) => call.arguments.operation), ['prepare', 'create']);
  assert.equal(JSON.stringify(started.interaction).includes('referenceAnswer'), false);
  assert.equal(JSON.stringify(started.toolInvocations).includes('Fish live in water.'), false);
  assert.equal(JSON.stringify(started.toolInvocations).includes('Mentions water.'), false);
  const count = modelRequests.length;
  const { result: second } = await submit('Submit', assessQuizAnswer('correct'),
    quizSubmission(started.interaction, 'submit', { answer: 'In water.' }));
  assert.equal(modelRequests.length, count + 2, 'The agent calls answer once; grading is owned by the tool');
  assert.equal(second.interaction.stepId, 'question-2');
  assert.equal(second.interaction.prompt, 'What covers birds?');
  assert.equal(second.quiz.correct, 1);
  assert.equal(second.quiz.remaining, 1);
  const card = second.interaction;
  const { result: completed } = await submit('Fur.', assessQuizAnswer('incorrect', {
    action: 'submit', fields: [{ id: 'answer', value: 'Fur.', selections: null }],
  }), { interactionContext: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: 'quiz',
  } });
  assert.equal(completed.interaction.status, 'completed');
  assert.equal(completed.interaction.prompt, 'What covers birds?');
  assert.deepEqual(completed.interaction.values, { answer: 'Fur.' });
  assert.deepEqual(completed.interaction.allowedActions, []);
  assert.equal(completed.quiz.correct, 1);
  assert.equal(completed.quiz.incorrect, 1);
  assert.equal(completed.quiz.skipped, 0);
  assert.equal(completed.quiz.answered, 2);
  assert.equal(completed.quiz.remaining, 0);
  assert.equal(completed.quiz.percentage, 50);
  assert.equal(completed.quiz.provisional, false);
  assert.deepEqual(calls, { preview: 0, save: 0, search: 0, process: 0 });
});

test('completed quiz cards stay in the completion turn, not follow-up replies or saved-results reads', async () => {
  setup();
  const started = await createRealQuiz(1);
  const { result: completed } = await submit('Submit', assessQuizAnswer('correct'),
    quizSubmission(started.interaction, 'submit', { answer: 'A supported answer.' }));
  assert.equal(completed.interaction.status, 'completed');
  const savedVersion = (await savedQuiz()).version;
  const { result: followup } = await submit('Thank you.', [final('You are welcome.')]);
  assert.equal(followup.interaction, undefined);
  assert.equal(followup.familyPayload.interaction, undefined);
  assert.equal(followup.quiz.status, 'completed');
  assert.equal((await savedQuiz()).version, savedVersion, 'A follow-up must not re-present the old card');

  for (const operation of ['results', 'resume', 'question']) {
    const { result } = await submit('Show my completed quiz results.', [
      tools(tool('quiz', quizArgs(operation, { quizId: started.quiz.quizId }))),
      final('Your saved quiz is complete.'),
    ]);
    assert.equal(result.interaction, undefined);
    assert.equal(result.familyPayload.interaction, undefined);
    assert.equal(result.quiz.status, 'completed');
  }

  const restartRequest = 'Take this quiz again with one question.';
  const { result: restarted } = await submit(restartRequest, [
    async () => tools(tool('quiz', quizArgs('restart', {
      quizId: started.quiz.quizId, version: (await savedQuiz()).version,
      questionCount: 1, restartRequest,
    }))),
    final('Answer the new question.'),
  ]);
  assert.equal(restarted.interaction.status, 'active');
  assert.ok(restarted.interaction.allowedActions.includes('submit'));
});

test('recovery retains a just-completed quiz card but does not repeat it on later failed turns', async () => {
  setup();
  const started = await createRealQuiz(1);
  let failure;
  await assert.rejects(submit('Submit', [
    ...assessQuizAnswer('correct').slice(0, 1),
    () => { throw new Error('Model unavailable after final grading'); },
  ], quizSubmission(started.interaction, 'submit', { answer: 'A supported answer.' })), (error) => {
    failure = error;
    assert.match(error.message, /Model unavailable after final grading/);
    assert.equal(error.interaction.status, 'completed');
    return true;
  });
  context = failure.laneContext;
  await assert.rejects(submit('Thank you.', [
    () => { throw new Error('Later model failure'); },
  ]), (error) => {
    assert.match(error.message, /Later model failure/);
    assert.equal(error.interaction, null);
    return true;
  });
  assert.equal((await savedQuiz(started.quiz.quizId)).questions.filter((question) => question.resolution).length, 1);
});

test('new quizzes use the source language rather than chat language and retain it for grading, resume and restart', async () => {
  for (const [chatLanguage, sourceLanguage] of [['en', 'da'], ['da', 'en']]) {
    setup();
    globalThis.__laneQuizLanguage = sourceLanguage;
    const sources = globalThis.__laneQuizSources;
    globalThis.__laneQuizSources = async (...args) => {
      const snapshot = await sources(...args);
      if (snapshot.leaves && sourceLanguage === 'da') {
        snapshot.leaves[0].notes = 'Fisk lever i vand.';
        snapshot.leaves[1].notes = 'Fugle har fjer.';
      }
      return snapshot;
    };
    const generate = globalThis.__laneQuizGenerate;
    let generations = 0;
    globalThis.__laneQuizGenerate = async (input) => {
      generations++;
      assert.equal(input.language, sourceLanguage);
      const bank = await generate(input);
      if (sourceLanguage === 'da') {
        bank.questions[0].question = 'Hvor lever fisk?';
        bank.questions[0].referenceAnswer = 'Fisk lever i vand.';
        bank.questions[0].gradingCriteria = 'Svaret skal omfatte vand.';
      }
      return bank;
    };
    const { result: started } = await submit(chatLanguage === 'da' ? 'Start en quiz om dyr.' : 'Quiz me about Animals.', [
      tools(quizSwitch(), tool('quiz', quizArgs('prepare', { treeId: '1', rootIds: ['10'] }))),
      async () => {
        const state = await savedQuiz();
        assert.equal(state.language, null, 'Preparation must not adopt the chat language');
        return tools(tool('quiz', quizArgs('create', { quizId: state.id, version: state.version })));
      },
      final(chatLanguage === 'da' ? 'Svar i kortet.' : 'Answer in the card.', {
        responseLanguage: chatLanguage, languageReason: 'The current human message determines reply language.',
      }),
    ], { language: chatLanguage });
    assert.equal((await savedQuiz()).language, sourceLanguage);
    assert.equal(started.interaction.prompt, sourceLanguage === 'da' ? 'Hvor lever fisk?' : 'Where do fish live?');
    let grades = 0;
    globalThis.__laneQuizGrade = async (input) => {
      grades++;
      assert.equal(input.language, sourceLanguage);
      return { verdict: 'correct', feedback: sourceLanguage === 'da' ? 'Korrekt.' : 'Correct.' };
    };
    await submit('Submit', [
      currentQuizOperation('answer'), final('Continue in the card.'),
    ], quizSubmission(started.interaction, 'submit', { answer: 'Water.' }));
    assert.equal(grades, 1);
    globalThis.__laneQuizLanguage = chatLanguage;
    let state = await savedQuiz();
    await submit('Resume this quiz.', [
      tools(tool('quiz', quizArgs('resume', { quizId: state.id }))), final('Continue in the card.'),
    ]);
    state = await savedQuiz();
    const message = 'Take this quiz again.';
    await submit(message, [
      tools(tool('quiz', quizArgs('restart', { quizId: state.id, version: state.version, restartRequest: message }))),
      final('Answer in the card.'),
    ]);
    assert.equal((await savedQuiz()).language, sourceLanguage);
    assert.equal(generations, 1);
  }
});

test('unclear source language waits for a new human choice, preserving the requested quiz size across resume', async () => {
  setup();
  globalThis.__laneQuizLanguage = 'und';
  const { result: waiting } = await submit('Make a one-question quiz.', [
    tools(quizSwitch(), tool('quiz', quizArgs('prepare', { treeId: '1', rootIds: ['10'] }))),
    async () => {
      const state = await savedQuiz();
      return tools(tool('quiz', quizArgs('create', { quizId: state.id, version: state.version, questionCount: 1 })));
    },
    async () => {
      const state = await savedQuiz();
      return tools(tool('quiz', quizArgs('create', { quizId: state.id, version: state.version, language: 'en' })));
    },
    final('The source language is unclear. English or Danish?'),
  ]);
  let state = await savedQuiz();
  assert.equal(state.language, 'und');
  assert.equal(state.questionCount, 1);
  assert.equal(state.status, 'preparing');
  assert.equal(state.bank.length, 0);
  assert.ok(!waiting.interaction);
  assert.equal(globalThis.__laneQuizPlanningCalls, 1);
  assert.match(JSON.stringify(modelRequests.at(-1).request.input), /Wait for a new human language choice/);
  await submit('Continue this quiz.', [
    tools(tool('quiz', quizArgs('resume', { quizId: state.id }))),
    async () => {
      const latest = await savedQuiz();
      return tools(tool('quiz', quizArgs('create', { quizId: latest.id, version: latest.version })));
    },
    final('Please choose English or Danish.'),
  ]);
  assert.equal(globalThis.__laneQuizPlanningCalls, 1, 'Resume must not rerun inference while waiting for the human');
  state = await savedQuiz();
  const { result: started } = await submit('English, please.', [
    tools(tool('quiz', quizArgs('create', { quizId: state.id, version: state.version, language: 'en' }))),
    final('Answer in the card.'),
  ]);
  state = await savedQuiz();
  assert.equal(state.language, 'en');
  assert.equal(state.status, 'active');
  assert.equal(state.questionCount, 1);
  assert.equal(started.quiz.total, 1);
  assert.equal(globalThis.__laneQuizPlanningCalls, 2);
});

test('a failed creation can recover on round five and return the committed first question', async () => {
  setup();
  const generate = globalThis.__laneQuizGenerate;
  let generationCalls = 0;
  globalThis.__laneQuizGenerate = async (input) => {
    generationCalls++;
    if (generationCalls === 1) throw new Error('Invalid typed quiz question 1: options must contain 3 to 6 entries');
    return generate(input);
  };
  const create = async () => {
    const state = await savedQuiz();
    return tools(tool('quiz', quizArgs('create', { quizId: state.id, version: state.version })));
  };
  const { result } = await submit('Generate a quiz about Animals.', [
    tools(quizSwitch(), tool('quiz', quizArgs('list'))),
    tools(tool('quiz', quizArgs('prepare', { treeId: '1', rootIds: ['10'] }))),
    create,
    async () => tools(tool('quiz', quizArgs('resume', { quizId: (await savedQuiz()).id }))),
    create,
    final('Answer the first question.'),
  ]);
  assert.equal(generationCalls, 2);
  assert.equal(modelRequests.length, 6);
  assert.equal(modelRequests.at(-1).request.tool_choice, 'none');
  assert.equal(result.interaction.stepId, 'question-1');
  assert.equal(result.interaction.prompt, 'Where do fish live?');
  assert.equal(result.quiz.remaining, 2);
  const state = await savedQuiz();
  assert.equal(state.status, 'active');
  assert.equal(state.bank.length, 2);
  assert.equal(state.questions.length, 2);
  assert.ok(state.questions.every((question) => !question.resolution));
});

test('the tool generates 45 candidates and defaults to a coverage-first 25-question run preserved across resume', async () => {
  setup();
  globalThis.__laneQuizGenerate = async ({ source }) => ({
    title: 'Larger bank',
    assessments: source.leaves.map((leaf, index) => ({
      leafId: leaf.id, supportedTypes: ['text'], questionCount: index ? 22 : 23, reason: 'Distinct supported objectives.',
    })),
    questions: Array.from({ length: 45 }, (_, index) => ({
      ...quizBank[index % 2], question: `Question ${index}?`, learningObjective: `Objective ${index}`,
    })),
  });
  const started = await createRealQuiz();
  const stored = await savedQuiz();
  assert.equal(stored.bank.length, 45);
  assert.equal(stored.questionCount, 25);
  assert.equal(stored.questions.length, 25);
  assert.equal(started.quiz.total, 25);
  assert.equal(new Set(stored.questions.slice(0, 2).map((question) => question.leafId)).size, 2);
  const { result } = await submit('Resume this quiz.', [
    tools(tool('quiz', quizArgs('resume', { quizId: stored.id }))), final('Continue the saved quiz.'),
  ]);
  assert.equal(result.interaction.prompt, started.interaction.prompt);
  assert.deepEqual((await savedQuiz()).questions, stored.questions);
});

test('taking a quiz again can choose a new size without generation and cannot answer the new run in the same turn', async () => {
  setup();
  let generated = 0;
  globalThis.__laneQuizGenerate = async ({ source }) => {
    generated++;
    return {
      title: 'Reusable bank',
      assessments: source.leaves.map((leaf, index) => ({
        leafId: leaf.id, supportedTypes: ['text'], questionCount: index ? 22 : 23, reason: 'Distinct supported objectives.',
      })),
      questions: Array.from({ length: 45 }, (_, index) => ({
        ...quizBank[index % 2], question: `Question ${index}?`, learningObjective: `Objective ${index}`,
      })),
    };
  };
  const started = await createRealQuiz(10);
  await submit('Submit', assessQuizAnswer('correct'),
    quizSubmission(started.interaction, 'submit', { answer: 'My first answer.' }));
  const previous = await savedQuiz();
  const { result: sizeOffer } = await submit('Take this quiz again.', [final('Use the default 25 questions, or choose 1-45?')]);
  const awaitingSize = await savedQuiz();
  assert.equal(awaitingSize.questionCount, 10);
  assert.deepEqual(awaitingSize.questions, previous.questions);
  const message = '45';
  const { result } = await submit(message, [
    tools(tool('quiz', quizArgs('restart', {
      quizId: awaitingSize.id, version: awaitingSize.version, questionCount: 45, restartRequest: message,
    }))),
    currentQuizOperation('reveal', { revealRequest: message }),
    final('The previous run was discarded. Here is the first question of the new run.'),
  ], { interactionContext: {
    interactionId: sizeOffer.interaction.interactionId, stepId: sizeOffer.interaction.stepId,
    version: sizeOffer.interaction.version, workflow: 'quiz',
  } });
  const restarted = await savedQuiz();
  assert.equal(generated, 1);
  assert.equal(restarted.id, previous.id);
  assert.equal(restarted.bank.length, 45);
  assert.equal(restarted.questions.length, 45);
  assert.equal(restarted.questionCount, 45);
  assert.deepEqual(restarted.bank, previous.bank);
  assert.deepEqual(restarted.source, previous.source);
  assert.equal(result.quiz.correct, 0);
  assert.equal(result.quiz.skipped, 0);
  assert.equal(result.quiz.remaining, 45);
  assert.equal(result.interaction.stepId, 'question-1');
  assert.equal(result.interaction.review, undefined);
  assert.equal(restarted.pending, null);
  assert.ok(restarted.questions.every((question) => question.resolution === null));
  const restartedCalls = result.familyPayload.responseToolInvocations.filter((call) => call.arguments.operation === 'restart');
  assert.equal(restartedCalls.length, 1);
  assert.equal(restartedCalls[0].arguments.restartRequest, undefined);
  const { result: resumed } = await submit('Continue this quiz.', [
    tools(tool('quiz', quizArgs('resume', { quizId: restarted.id }))), final('Continue the new run.'),
  ]);
  assert.deepEqual((await savedQuiz()).questions, restarted.questions);
  assert.equal(resumed.interaction.prompt, result.interaction.prompt);
  const current = await savedQuiz();
  const defaultRequest = 'Take it again with the default size.';
  const { result: defaultRun } = await submit(defaultRequest, [
    tools(tool('quiz', quizArgs('restart', { quizId: current.id, version: current.version, restartRequest: defaultRequest }))),
    final('Started with the default size.'),
  ]);
  assert.equal(defaultRun.quiz.total, 25);
  assert.equal((await savedQuiz()).questionCount, 25);
  assert.equal(generated, 1);
});

test('restart needs the current human request, cannot reinterpret a captured card, and can explicitly discard pending recovery', async () => {
  setup();
  const started = await createRealQuiz();
  const before = await savedQuiz();
  const { result: unchanged } = await submit('What is my progress?', [
    tools(tool('quiz', quizArgs('restart', { quizId: before.id, version: before.version, restartRequest: 'Invented approval' }))),
    final('No restart was authorized.'),
  ]);
  assert.deepEqual((await savedQuiz()).questions, before.questions);
  const current = await savedQuiz();
  const { result: graded } = await submit('Submit', [
    tools(tool('quiz', quizArgs('restart', { quizId: current.id, version: current.version + 1, restartRequest: 'Submit' }))),
    ...assessQuizAnswer('correct'),
  ], quizSubmission(unchanged.interaction, 'submit', { answer: 'My answer.' }));
  assert.equal(graded.quiz.correct, 1);
  globalThis.__laneQuizGrade = async () => { throw new Error('Grading interrupted'); };
  await assert.rejects(submit('Submit', [
    currentQuizOperation('answer'), () => { throw new Error('Turn interrupted after grading failure'); },
  ], quizSubmission(graded.interaction, 'submit', { answer: 'Pending old answer.' })), /Turn interrupted/);
  const pending = await savedQuiz();
  assert.ok(pending.pending);
  context = { conversationId: 'restart-recovery-conversation', version: 0 };
  history = [];
  const message = 'Discard the old run and take this quiz again.';
  const { result } = await submit(message, [
    tools(quizSwitch(), tool('quiz', quizArgs('restart', { quizId: pending.id, version: pending.version, restartRequest: message }))),
    final('The old run was discarded.'),
  ]);
  assert.equal(result.quiz.correct, 0);
  assert.equal(result.quiz.remaining, 2);
  assert.equal((await savedQuiz()).pending, null);
});

test('a forty-five-note sample survives generation failure and a smaller quiz is selected only from the full bank', async () => {
  setup();
  const sourceProvider = globalThis.__laneQuizSources;
  const snapshot = {
    treeId: '1', rootIds: ['10'], fingerprint: 'a'.repeat(64),
    leaves: Array.from({ length: 45 }, (_, index) => ({
      id: String(100 + index), rootId: '10', title: `Topic ${index}`, path: `Animals > Topic ${index}`,
      notes: `Supported fact ${index}.`, revision: null,
    })),
    excludedLeaves: Array.from({ length: 15 }, (_, index) => ({
      id: String(200 + index), reason: 'random-sample-limit',
    })),
  };
  let sourceReads = 0;
  globalThis.__laneQuizSources = async (operation, options) => {
    if (operation !== 'prepare') return sourceProvider(operation, options);
    if (++sourceReads === 1) assert.equal(options.selectedLeafIds, undefined);
    else assert.deepEqual(options.selectedLeafIds, snapshot.leaves.map((leaf) => leaf.id));
    return structuredClone(snapshot);
  };
  let generations = 0;
  globalThis.__laneQuizGenerate = async ({ source }) => {
    assert.deepEqual(source, snapshot);
    if (++generations === 1) throw new Error('Temporary generation failure');
    return {
      title: 'Full sampled bank',
      assessments: source.leaves.map((leaf) => ({
        leafId: leaf.id, supportedTypes: ['text'], questionCount: 1, reason: 'One supported fact.',
      })),
      questions: source.leaves.map((leaf) => ({
        ...quizBank[0], leafId: leaf.id, question: `Question for ${leaf.id}?`, learningObjective: `Understand ${leaf.id}`,
      })),
    };
  };
  await createRealQuiz(25);
  const prepared = await savedQuiz();
  assert.equal(prepared.status, 'preparing');
  assert.deepEqual(prepared.source, snapshot);
  const summaries = modelRequests.flatMap(({ request }) => request.input
    .filter((item) => item.type === 'function_call_output')
    .map((item) => JSON.parse(item.output).data?.sourceSummary)).filter(Boolean);
  assert.equal(summaries[0].eligibleNotes, 45);
  assert.equal(summaries[0].totalEligibleNotes, 60);
  assert.equal(summaries[0].sampledOutNotes, 15);
  const { result } = await submit('Resume and retry with 25 questions.', [
    tools(tool('quiz', quizArgs('resume', { quizId: prepared.id }))),
    async () => {
      const state = await savedQuiz();
      return tools(tool('quiz', quizArgs('create', { quizId: state.id, version: state.version, questionCount: 25 })));
    },
    final('The saved sample now has a full bank and a 25-question quiz.'),
  ]);
  const active = await savedQuiz();
  assert.equal(active.bank.length, 45);
  assert.equal(active.questions.length, 25);
  assert.deepEqual(active.source, prepared.source);
  assert.equal(sourceReads, 2, 'Retry must not discover and sample a new source selection');
  assert.equal(result.quiz.total, 25);
});

test('closed answers and reveals expose all explanations only after resolution without a grading model call', async () => {
  for (const [type, answer, action] of [
    ['single_choice', 'option-2'], ['multiple_choice', ['option-2', 'option-1']], ['yes_no', 'no'],
  ].flatMap(([type, answer]) => ['submit', 'reveal'].map((action) => [type, answer, action]))) {
    setup();
    const generate = globalThis.__laneQuizGenerate;
    globalThis.__laneQuizGenerate = async (input) => {
      const bank = await generate(input);
      bank.assessments[0].supportedTypes = [type];
      bank.questions[0] = {
        ...bank.questions[0], type,
        options: type === 'yes_no' ? [] : ['Alpha', 'Beta', 'Gamma'].map((label, index) => ({ id: `option-${index + 1}`, label })),
        correctOptionIds: type === 'yes_no' ? ['no'] : type === 'single_choice' ? ['option-2'] : ['option-1', 'option-2'],
        optionExplanations: (type === 'yes_no' ? ['yes', 'no'] : ['option-1', 'option-2', 'option-3']).map((optionId) => ({
          optionId, explanation: `PRIVATE_OPTION_REASON_${optionId}`,
        })),
      };
      return bank;
    };
    const started = await createRealQuiz();
    assert.doesNotMatch(JSON.stringify(started), /PRIVATE_OPTION_REASON|optionExplanations|isCorrect/);
    let modelGrades = 0;
    globalThis.__laneQuizGrade = async () => { modelGrades++; throw new Error('Closed answers must not use model grading'); };
    const { result } = await submit('Submit', [
      currentQuizOperation(action === 'submit' ? 'answer' : 'reveal'), final('Feedback and next question.'),
    ], quizSubmission(started.interaction, action, action === 'submit' ? { answer } : {}));
    assert.equal(result.quiz.correct, action === 'submit' ? 1 : 0);
    assert.equal(result.quiz.skipped, action === 'reveal' ? 1 : 0);
    assert.equal(result.quiz.remaining, 1);
    assert.equal(modelGrades, 0);
    assert.deepEqual((await savedQuiz()).questions[0].resolution.answer, action === 'submit' ? answer : null);
    assert.equal(result.interaction.review.items.length, type === 'yes_no' ? 2 : 3);
    assert.ok(result.interaction.review.items.every((item) => item.text.includes(`PRIVATE_OPTION_REASON_${item.id}`)));
    const output = JSON.parse(modelRequests.at(-1).request.input.filter((item) => item.type === 'function_call_output').at(-1).output);
    const explanations = output.data.answerReview.optionExplanations;
    assert.equal(explanations.length, type === 'yes_no' ? 2 : 3);
    assert.equal(explanations.filter((item) => item.isCorrect).length, type === 'multiple_choice' ? 2 : 1);
  }
});

test('a scoped unambiguous option label can be normalized to an ID without applying the free-text equality rule', async () => {
  setup();
  const generate = globalThis.__laneQuizGenerate;
  globalThis.__laneQuizGenerate = async (input) => {
    const bank = await generate(input);
    bank.assessments[0].supportedTypes = ['single_choice'];
    bank.questions[0] = {
      ...bank.questions[0], type: 'single_choice', correctOptionIds: ['option-2'],
      options: ['Alpha', 'Beta', 'Gamma'].map((label, index) => ({ id: `option-${index + 1}`, label })),
      optionExplanations: ['option-1', 'option-2', 'option-3'].map((optionId) => ({
        optionId, explanation: `Evidence explaining ${optionId}.`,
      })),
    };
    return bank;
  };
  const started = await createRealQuiz();
  const { result } = await submit('Beta', [
    currentQuizOperation('answer', { response: { action: 'submit', fields: [{ id: 'answer', value: 'option-2', selections: null }] } }),
    final('Correct; continue.'),
  ], { interactionContext: {
    interactionId: started.interaction.interactionId, stepId: 'question-1', version: started.interaction.version, workflow: 'quiz',
  } });
  assert.equal(result.quiz.correct, 1);
  const instructions = modelRequests.at(-2).request.input
    .filter((item) => item.role === 'system').map((item) => item.content).join('\n');
  assert.ok(instructions.includes(JSON.stringify({
    questionId: 'question-1', leafId: '11', prompt: started.interaction.prompt,
    type: 'single_choice', options: started.interaction.fields[0].options,
  })), 'Scoped replies must be interpretable without a question/option transcript in assistant prose');
  assert.match(instructions, /do not copy or paraphrase them in chat/);
  assert.match(instructions, /Let the human expand the card's Answer explanations review/);
});

test('internal free-answer clarification stays unscored and a restated scoped answer preserves exact text', async () => {
  setup();
  const started = await createRealQuiz();
  globalThis.__laneQuizGrade = async () => ({ verdict: 'clarify', feedback: 'Please restate your complete answer.' });
  const { result: clarified } = await submit('Submit', [
    currentQuizOperation('answer'), final('Please restate your complete answer.'),
  ], quizSubmission(started.interaction, 'submit', { answer: 'That one.' }));
  assert.equal(clarified.quiz.answered, 0);
  assert.equal(clarified.quiz.remaining, 2);
  assert.equal(clarified.interaction.values.answer, 'That one.');
  assert.match(clarified.interaction.prompt, /Please restate/);
  const exact = '  In water.\n  ';
  globalThis.__laneQuizGrade = async ({ answer }) => {
    assert.equal(answer, exact);
    return { verdict: 'correct', feedback: 'Correct.' };
  };
  const { result } = await submit(exact, [
    currentQuizOperation('answer', { response: { action: 'submit', fields: [{ id: 'answer', value: exact, selections: null }] } }),
    final('Correct; next question.'),
  ], { interactionContext: {
    interactionId: clarified.interaction.interactionId, stepId: 'question-1', version: clarified.interaction.version, workflow: 'quiz',
  } });
  assert.equal(result.quiz.answered, 1);
  assert.equal((await savedQuiz()).questions[0].resolution.answer, exact);
  assert.equal((await savedQuiz()).clarification, null);
});

test('internal model failures preserve preparing records and captured answers for explicit retry', async () => {
  setup();
  globalThis.__laneQuizGenerate = async () => { throw new Error('Generation service unavailable'); };
  await submit('Create a quiz.', [
    tools(quizSwitch(), tool('quiz', quizArgs('prepare', { treeId: '1', rootIds: ['10'] }))),
    async () => {
      const state = await savedQuiz();
      return tools(tool('quiz', quizArgs('create', { quizId: state.id, version: state.version })));
    },
    final('Generation failed; the prepared quiz can be resumed.'),
  ]);
  assert.equal((await savedQuiz()).status, 'preparing');
  assert.deepEqual((await savedQuiz()).bank, []);
  setup();
  const started = await createRealQuiz();
  globalThis.__laneQuizGrade = async () => { throw new Error('Grading service unavailable'); };
  await assert.rejects(submit('Submit', [
    currentQuizOperation('answer'), () => { throw new Error('Turn interrupted after grading failure'); },
  ], quizSubmission(started.interaction, 'submit', { answer: 'My saved attempt.' })), /Turn interrupted/);
  const stored = await savedQuiz(started.quiz.quizId);
  assert.equal(stored.pending.values.answer, 'My saved attempt.');
  assert.equal(stored.questions[0].resolution, null);
});

test('source changes during the internal generation call cannot activate the generated bank', async () => {
  setup();
  const generate = globalThis.__laneQuizGenerate;
  globalThis.__laneQuizGenerate = async (input) => {
    const bank = await generate(input);
    quizSourceChanged = true;
    return bank;
  };
  const result = await createRealQuiz();
  assert.equal(result.interaction, undefined);
  assert.equal((await savedQuiz()).status, 'preparing');
});

test('quiz setup uses bound sequential collector submissions and automatically continues to generation', async () => {
  setup();
  const currentSetup = async () => {
    const conversation = JSON.parse(await globalThis.__laneRead({
      pathSegments: ['Knowledge Trees', 'Conversations', 'State', context.conversationId],
    }));
    return JSON.parse(await globalThis.__laneRead({
      pathSegments: ['Knowledge Trees', 'Quiz Setups', 'By Setup ID', conversation.quizSetupId],
    }));
  };
  const collectSelection = async () => {
    const setup = await currentSetup();
    return tools(tool('collect_structured_input', {
      operation: 'start', interactionId: null, specification: setup.specification, response: null,
    }));
  };
  const { result: trees } = await submit('Make me a quiz.', [
    tools(quizSwitch(), tool('quiz', quizArgs('sources'))),
    collectSelection,
    final('Choose a tree.'),
  ]);
  assert.equal(trees.interaction.workflow, 'structured-input');
  assert.equal(trees.interaction.stepId, 'quiz-tree');
  assert.deepEqual(trees.interaction.allowedActions, ['submit', 'cancel']);
  const setupId = trees.laneContext.quizSetupId;
  const treeCard = trees.interaction;
  const { result: roots } = await submit('Animals', [
    tools(tool('quiz', quizArgs('sources', { setupId }))),
    collectSelection,
    final('Choose roots.'),
  ], { interactionSubmission: {
    interactionId: treeCard.interactionId, stepId: treeCard.stepId, version: treeCard.version,
    workflow: 'structured-input', submissionId: 'chosen-tree', action: 'submit', values: { tree: 'tree-1' },
  } });
  assert.equal(roots.interaction.stepId, 'quiz-roots');
  assert.notEqual(roots.interaction.interactionId, treeCard.interactionId);
  assert.equal(roots.laneContext.quizSetupId, setupId);
  const rootCard = roots.interaction;
  const { result: question } = await submit('Animals roots', [
    tools(tool('quiz', quizArgs('prepare', { setupId }))),
    async () => {
      const state = await savedQuiz();
      return tools(tool('quiz', quizArgs('create', {
        quizId: state.id, version: state.version,
      })));
    },
    final('First question.'),
  ], { interactionSubmission: {
    interactionId: rootCard.interactionId, stepId: rootCard.stepId, version: rootCard.version,
    workflow: 'structured-input', submissionId: 'chosen-roots', action: 'submit', values: { roots: ['root-10'] },
  } });
  assert.equal(question.interaction.workflow, 'quiz');
  assert.equal(question.quiz.remaining, 2);
  assert.equal(question.laneContext.quizSetupId, undefined);
  assert.equal(question.laneContext.quizId, question.quiz.quizId);
});

test('quiz reveal skips exactly once, presents the next question and cannot fabricate a future answer', async () => {
  setup();
  const started = await createRealQuiz();
  const { result } = await submit('Show answer and skip', [
    async () => {
      const state = await savedQuiz();
      return tools(tool('quiz', quizArgs('reveal', {
        quizId: state.id, version: state.version, questionId: 'question-1',
      })));
    },
    async () => {
      const state = await savedQuiz();
      return tools(tool('quiz', quizArgs('answer', {
        quizId: state.id, version: state.version, questionId: 'question-2',
        response: {
          action: 'submit', fields: [{ id: 'answer', value: 'Feathers', selections: null }],
        },
      })));
    },
    final('Fish live in water. The question was skipped.'),
  ], quizSubmission(started.interaction, 'reveal'));
  assert.equal(result.interaction.stepId, 'question-2');
  assert.equal(result.quiz.skipped, 1);
  assert.equal(result.quiz.answered, 0);
  assert.equal(result.quiz.correct, 0);
  assert.equal(result.quiz.remaining, 1);
  const state = await savedQuiz();
  assert.equal(state.questions[0].resolution.outcome, 'skipped');
  assert.equal(state.questions[1].resolution, null);
});

test('ordinary chat cannot supply quiz answers and revoked source access blocks capture before grading', async () => {
  setup();
  const started = await createRealQuiz();
  const { result } = await submit('The answer is water, but this is ordinary chat.', [
    async () => {
      const state = await savedQuiz();
      return tools(tool('quiz', quizArgs('answer', {
        quizId: state.id, version: state.version, questionId: 'question-1',
        response: { action: 'submit', fields: [{ id: 'answer', value: 'water', selections: null }] },
      })));
    },
    final('Use the quiz response mode or card to answer.'),
  ]);
  assert.equal(result.quiz.correct, 0);
  assert.equal(result.interaction.stepId, 'question-1');
  const before = modelRequests.length;
  quizAccessAllowed = false;
  await assert.rejects(submit('Submit', [], quizSubmission(result.interaction, 'submit', { answer: 'Water' })), {
    status: 403,
  });
  assert.equal(modelRequests.length, before);
  assert.equal((await savedQuiz(started.quiz.quizId)).questions[0].resolution, null);
});

test('a newly generated question cannot be revealed or resolved before a later human presentation', async () => {
  setup();
  const { result } = await submit('Quiz me about Animals.', [
    tools(quizSwitch(), tool('quiz', quizArgs('prepare', { treeId: '1', rootIds: ['10'] }))),
    async () => {
      const state = await savedQuiz();
      return tools(tool('quiz', quizArgs('create', {
        quizId: state.id, version: state.version,
      })), tool('quiz', quizArgs('reveal', {
        quizId: state.id, version: state.version + 1, questionId: 'question-1',
        revealRequest: 'Quiz me about Animals.',
      })));
    },
    final('First question.'),
  ]);
  assert.equal(result.interaction.stepId, 'question-1');
  assert.equal(result.quiz.remaining, 2);
  assert.equal(result.quiz.skipped, 0);
  assert.equal((await savedQuiz()).pending, null);
});

test('cancelling quiz source collection cannot prepare or activate a quiz', async () => {
  setup();
  const { result } = await submit('Make a quiz.', [
    tools(quizSwitch(), tool('quiz', quizArgs('sources', { treeId: '1' }))),
    async () => {
      const conversation = JSON.parse(await globalThis.__laneRead({
        pathSegments: ['Knowledge Trees', 'Conversations', 'State', context.conversationId],
      }));
      const setup = JSON.parse(await globalThis.__laneRead({
        pathSegments: ['Knowledge Trees', 'Quiz Setups', 'By Setup ID', conversation.quizSetupId],
      }));
      return tools(tool('collect_structured_input', {
        operation: 'start', interactionId: null, specification: setup.specification, response: null,
      }));
    },
    final('Choose roots.'),
  ]);
  await submitDirectCollectorCard(result.interaction, 'cancel');
  const { result: cancelled } = await submit('Continue setup.', [
    tools(tool('quiz', quizArgs('prepare', { setupId: result.laneContext.quizSetupId }))),
    final('The selection was cancelled; start fresh to make a quiz.'),
  ]);
  assert.equal(cancelled.quiz, undefined);
  assert.equal(cancelled.interaction, undefined);
  assert.equal(cancelled.laneContext.quizId, undefined);
});

test('more than 20 roots requires narrowing before a collector is started', async () => {
  setup();
  const sources = globalThis.__laneQuizSources;
  globalThis.__laneQuizSources = async (operation, options) => operation === 'roots' && !options.filter
    ? { treeId: '1', roots: [], total: 21, matching: 21, requiresNarrowing: true }
    : sources(operation, options);
  const { result: narrow } = await submit('Make a quiz about Animals.', [
    tools(quizSwitch(), tool('quiz', quizArgs('sources', { treeId: '1' }))),
    final('There are more than 20 roots. Narrow the root title.'),
  ]);
  assert.equal(narrow.interaction, undefined);
  const { result } = await submit('Use Animals roots.', [
    tools(tool('quiz', quizArgs('sources', { setupId: narrow.laneContext.quizSetupId, filter: 'Animals' }))),
    async () => {
      const setup = JSON.parse(await globalThis.__laneRead({
        pathSegments: ['Knowledge Trees', 'Quiz Setups', 'By Setup ID', narrow.laneContext.quizSetupId],
      }));
      return tools(tool('collect_structured_input', {
        operation: 'start', interactionId: null, specification: setup.specification, response: null,
      }));
    },
    final('Select from the matching roots.'),
  ]);
  assert.equal(result.laneContext.quizSetupId, narrow.laneContext.quizSetupId);
  assert.equal(result.interaction.workflow, 'structured-input');
  assert.deepEqual(result.interaction.fields[0].options.map(({ id }) => id), ['root-10']);
  assert.match(result.interaction.fields[0].options[0].label, /Animals/);
});

test('quiz recovery resumes a captured attempt or an already committed verdict without double scoring', async () => {
  for (const committed of [false, true]) {
    setup();
    const started = await createRealQuiz();
    let failure;
    try {
      await submit('Submit', [
        ...(committed ? assessQuizAnswer('correct').slice(0, 1) : []),
        () => { throw new Error('Model unavailable'); },
      ], quizSubmission(started.interaction, 'submit', { answer: 'Water.' }));
    } catch (error) {
      failure = error;
    }
    assert.match(failure?.message, /Model unavailable/);
    assert.deepEqual(failure.interaction.allowedActions, ['resume']);
    const stored = await savedQuiz(started.quiz.quizId);
    assert.equal(Boolean(stored.pending), !committed);
    assert.equal(stored.questions.filter((question) => question.resolution).length, committed ? 1 : 0);
    context = { conversationId: 'recovered-quiz-conversation', version: 0 };
    history = [];
    const { result } = await submit('Resume my Animals quiz.', [
      tools(quizSwitch(), tool('quiz', quizArgs('resume', { quizId: stored.id }))),
      ...(committed ? [final('Continue with the second question.')] : assessQuizAnswer('correct')),
    ]);
    assert.equal(result.interaction.stepId, 'question-2');
    assert.equal(result.quiz.correct, 1);
    assert.equal(result.quiz.remaining, 1);
    const recovered = await savedQuiz(stored.id);
    assert.equal(recovered.pending, null);
    assert.equal(recovered.questions[0].resolution.answer, 'Water.');
  }
});

test('preparation can resume its frozen evidence after an interrupted generation turn', async () => {
  setup();
  await assert.rejects(submit('Quiz me about Animals.', [
    tools(quizSwitch(), tool('quiz', quizArgs('prepare', { treeId: '1', rootIds: ['10'] }))),
    () => { throw new Error('Generation interrupted'); },
  ]), /Generation interrupted/);
  const prepared = await savedQuiz();
  context = { conversationId: 'generation-recovery-conversation', version: 0 };
  history = [];
  const { result } = await submit('Resume creating my quiz.', [
    tools(quizSwitch(), tool('quiz', quizArgs('resume', { quizId: prepared.id }))),
    () => {
      assert.doesNotMatch(JSON.stringify(modelRequests.at(-1).request.input), /Fish live in water/);
      return tools(tool('quiz', quizArgs('create', {
        quizId: prepared.id, version: prepared.version + 1,
      })));
    },
    final('Answer the first question.'),
  ]);
  assert.equal(result.quiz.status, 'active');
  assert.equal(result.interaction.stepId, 'question-1');
});

test('another saved quiz cannot be presented or answered without explicitly resuming it', async () => {
  setup();
  const first = await createRealQuiz();
  const second = await createRealQuiz();
  const { result } = await submit('Show the other quiz question.', [
    tools(tool('quiz', quizArgs('question', { quizId: first.quiz.quizId }))),
    final('Resume that quiz first.'),
  ]);
  assert.equal(result.interaction, undefined);
  assert.equal(result.laneContext.quizId, second.quiz.quizId);
  await assert.rejects(submit('Submit', [], quizSubmission(first.interaction, 'submit', { answer: 'Water.' })),
    /Explicitly resume this detached quiz/);
  assert.equal((await savedQuiz(first.quiz.quizId)).pending, null);
});

test('resuming a source-selection collection restores its quiz setup in a fresh conversation', async () => {
  setup();
  const { result: selection } = await submit('Make a quiz.', [
    tools(quizSwitch(), tool('quiz', quizArgs('sources'))),
    async () => {
      const state = JSON.parse(await globalThis.__laneRead({
        pathSegments: ['Knowledge Trees', 'Conversations', 'State', context.conversationId],
      }));
      const setup = JSON.parse(await globalThis.__laneRead({
        pathSegments: ['Knowledge Trees', 'Quiz Setups', 'By Setup ID', state.quizSetupId],
      }));
      return tools(tool('collect_structured_input', {
        operation: 'start', interactionId: null, specification: setup.specification, response: null,
      }));
    },
    final('Choose the source tree.'),
  ]);
  context = { conversationId: 'resumed-source-selection', version: 0 };
  history = [];
  const { result } = await submit('Resume my quiz source selection.', [
    tools(quizSwitch(), tool('collect_structured_input', {
      operation: 'resume', interactionId: selection.interaction.interactionId, specification: null, response: null,
    })),
    final('Choose the source tree.'),
  ]);
  assert.equal(result.interaction.interactionId, selection.interaction.interactionId);
  assert.equal(result.laneContext.quizSetupId, selection.laneContext.quizSetupId);
  assert.deepEqual(result.interaction.allowedActions, ['submit', 'cancel']);
});

test('listing quizzes and reading unbound results return spoiler-free metadata without presenting another quiz', async () => {
  setup();
  const started = await createRealQuiz();
  const stored = await savedQuiz(started.quiz.quizId);
  globalThis.__laneQuizRows = [{ quizId: stored.id, notes: JSON.stringify(stored) }];
  context = { conversationId: 'quiz-results-conversation', version: 0 };
  history = [];
  for (const operation of ['list', 'results']) {
    const { result } = await submit(`Show quiz ${operation}.`, [
      tools(...(operation === 'list' ? [quizSwitch()] : []),
        tool('quiz', quizArgs(operation, operation === 'list' ? { offset: 0 } : { quizId: stored.id }))),
      () => {
        const output = modelRequests.at(-1).request.input.filter((item) => item.type === 'function_call_output').at(-1).output;
        assert.doesNotMatch(output, /referenceAnswer|gradingCriteria|Fish live in water/);
        const data = JSON.parse(output).data;
        if (operation === 'list') assert.match(output, /Animals quiz/);
        else {
          assert.equal(data.quizId, stored.id);
          assert.equal(data.correct, 0);
          assert.equal(data.remaining, 2);
          assert.equal(data.provisional, true);
        }
        return final('Your saved quiz is unfinished.');
      },
    ]);
    assert.equal(result.interaction, undefined);
    assert.equal(result.laneContext.quizId, undefined);
  }
});

test('changed source evidence cannot activate a generated quiz bank', async () => {
  setup();
  const { result } = await submit('Quiz me about Animals.', [
    tools(quizSwitch(), tool('quiz', quizArgs('prepare', { treeId: '1', rootIds: ['10'] }))),
    async () => {
      const state = await savedQuiz();
      quizSourceChanged = true;
      return tools(tool('quiz', quizArgs('create', {
        quizId: state.id, version: state.version,
      })));
    },
    final('The source material changed; no playable quiz was activated.'),
  ]);
  assert.equal(result.interaction, undefined);
  assert.equal(result.quiz.status, 'preparing');
  assert.equal((await savedQuiz()).questions.length, 0);
});

test('quiz detach and fresh-conversation resume preserve durable progress without old chat history', async () => {
  setup();
  const started = await createRealQuiz();
  const { result: answered } = await submit('Submit', assessQuizAnswer('correct'),
    quizSubmission(started.interaction, 'submit', { answer: 'Water.' }));
  const quizId = answered.quiz.quizId;
  const { result: left } = await submit('Find more about fish.', [
    tools(tool('switch_tree_lane', { activeLane: 'knowledge.retrieval', reason: 'The human requested search.' }),
      tool('search_tree_topics_1', { query: 'fish' })), final('Fish live in water.'),
  ]);
  assert.equal(left.laneContext.quizId, undefined);
  assert.equal(left.interaction, undefined);
  context = { conversationId: 'fresh-quiz-conversation', version: 0 };
  history = [];
  const { result: resumed } = await submit('Resume my Animals quiz.', [
    tools(quizSwitch(), tool('quiz', quizArgs('resume', { quizId }))),
    final('Continue with the second question.'),
  ]);
  assert.equal(resumed.interaction.stepId, 'question-2');
  assert.equal(resumed.quiz.correct, 1);
  assert.equal(resumed.quiz.remaining, 1);
  assert.equal(resumed.laneContext.quizId, quizId);
});

test('the shared collector starts in any lane without authorizing retrieval or saving', async () => {
  for (const activeLane of ['knowledge.retrieval', 'knowledge.saving', 'quiz']) {
    setup();
    const switching = activeLane === 'knowledge.retrieval' ? [] : [
      tool('switch_tree_lane', { activeLane, reason: 'Prepare the requested lane.' }),
    ];
    const { result } = await submit('Test structured interaction.', [
      tools(...switching, tool('collect_structured_input', {
        operation: 'start', interactionId: null, specification: buildCollectionTestSpecification(), response: null,
      })),
      final('Choose a topic.'),
    ]);
    assert.equal(result.laneContext.activeLane, activeLane);
    assert.equal(result.interaction.workflow, 'structured-input');
    assert.equal(result.interaction.stepId, 'topic');
    assert.equal(result.interaction.progress.total, 4);
    assert.deepEqual(calls, { preview: 0, save: 0, search: 0, process: 0 });
  }
});

test('ordinary chat remains independent, while a scoped interpreted response advances only its collector', async () => {
  setup();
  const { result: started } = await submit('Test structured interaction.', [
    tools(tool('collect_structured_input', {
      operation: 'start', interactionId: null, specification: buildCollectionTestSpecification(), response: null,
    })), final('Choose a topic.'),
  ]);
  const { result: ordinary } = await submit('Tell me about fish.', [
    tools(tool('search_tree_topics_1', { query: 'fish' })), final('Fish live in water.'),
  ]);
  assert.equal(ordinary.interaction, undefined);
  assert.equal(calls.search, 1);
  const card = started.interaction;
  const { result } = await submit('The topic about plants and animals.', [
    tools(tool('search_tree_topics_1', { query: 'plants' }), tool('collect_structured_input', {
      operation: 'respond', interactionId: card.interactionId, specification: null,
      response: { action: 'continue', fields: [{ id: 'topic', value: 'nature', selections: null }] },
    })), final('Enter a short note.'),
  ], { interactionContext: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
  } });
  assert.equal(result.interaction.stepId, 'note');
  assert.deepEqual(result.interaction.collectedValues, { topic: { topic: 'nature' } });
  assert.equal(calls.search, 1);
  assert.equal(calls.save, 0);
});

async function collectorAtSubmit() {
  const specification = buildCollectionTestSpecification();
  specification.steps = specification.steps.slice(0, 2);
  const { result: started } = await submit('Collect my topic before continuing.', [
    tools(tool('collect_structured_input', {
      operation: 'start', interactionId: null, specification, response: null,
    })), final('Choose a topic.'),
  ]);
  const card = started.interaction;
  const { result } = await submit('Nature', [], { interactionSubmission: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    submissionId: `topic-${card.version}`, action: 'continue', values: { topic: 'nature' },
  } });
  return result.interaction;
}

async function submitDirectCollectorCard(card, action, values = {}, extra = {}) {
  const previousModels = modelRequests.length;
  const previousFoundry = globalThis.__laneFoundry.length;
  const { result } = await submit(action, [], {
    includeDebug: true, ...extra, interactionSubmission: {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
      submissionId: `direct-${turnSequence + 1}`, action, values,
    },
  });
  assert.equal(modelRequests.length, previousModels);
  assert.equal(globalThis.__laneFoundry.length, previousFoundry, 'No client, published-agent lookup or tool discovery');
  assert.equal(result.agent, null);
  assert.deepEqual(result.toolsUsed, []);
  assert.deepEqual(result.toolInvocations, []);
  assert.deepEqual(result.citations, []);
  assert.equal(result.knowledgeMode, 'grounded');
  assert.equal(result.isPersistenceOffer, false);
  assert.equal(result.isPermissionToBroadenRequest, false);
  assert.equal(result.isWaitingForContinuation, false);
  assert.deepEqual(result.familyPayload.interaction, result.interaction);
  assert.equal(result.answer, result.interaction.prompt);
  assert.equal(result.debug.executionMode, 'server-interaction');
  assert.deepEqual(result.debug.timings.modelCalls, []);
  return result;
}

test('collector cards handle resume, fields, Back/edit invalidation and cancellation without Foundry', async () => {
  for (const language of ['en', 'da']) {
    setup();
    const { result: started } = await submit('Collect information.', [
      tools(tool('collect_structured_input', {
        operation: 'start', interactionId: null, specification: buildCollectionTestSpecification(language), response: null,
      })), final('Choose a topic.'),
    ], { language });
    let result = await submitDirectCollectorCard(started.interaction, 'resume');
    assert.equal(result.interaction.stepId, 'topic');
    result = await submitDirectCollectorCard(result.interaction, 'continue', { topic: 'nature' });
    assert.equal(result.interaction.stepId, 'note');
    result = await submitDirectCollectorCard(result.interaction, 'continue', { note: 'My exact note.' });
    assert.equal(result.interaction.stepId, 'features');
    result = await submitDirectCollectorCard(result.interaction, 'continue', { features: ['choices', 'navigation'] });
    assert.equal(result.interaction.stepId, 'feedback');
    result = await submitDirectCollectorCard(result.interaction, 'back');
    assert.deepEqual(result.interaction.values, { features: ['choices', 'navigation'] });
    result = await submitDirectCollectorCard(result.interaction, 'back');
    assert.deepEqual(result.interaction.values, { note: 'My exact note.' });
    result = await submitDirectCollectorCard(result.interaction, 'back');
    assert.deepEqual(result.interaction.values, { topic: 'nature' });
    result = await submitDirectCollectorCard(result.interaction, 'continue', { topic: 'technology' });
    assert.deepEqual(result.interaction.collectedValues, { topic: { topic: 'technology' } });
    assert.deepEqual(result.interaction.values, { note: '' });
    result = await submitDirectCollectorCard(result.interaction, 'cancel');
    assert.equal(result.interaction.status, 'cancelled');
    assert.deepEqual(result.interaction.allowedActions, []);
    assert.equal(result.responseLanguage, language, 'Direct replies follow the saved collection language');
    assert.equal(result.answer, language === 'da' ? 'Indsamlingen er annulleret' : 'Collection cancelled');
    assert.deepEqual(calls, { preview: 0, save: 0, search: 0, process: 0 });
  }
});

test('invalid or stale collector cards fail before Foundry and do not advance the collection', async () => {
  setup();
  const card = await collectorAtSubmit();
  const previousModels = modelRequests.length;
  const previousFoundry = globalThis.__laneFoundry.length;
  for (const change of [
    { version: card.version - 1 },
    { stepId: 'topic' },
    { values: { note: '' } },
    { values: { invented: 'Not a field.' } },
    { action: 'continue' },
  ]) {
    await assert.rejects(submit('Submit', [], { interactionSubmission: {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
      submissionId: `invalid-${turnSequence + 1}`, action: 'submit', values: { note: 'Ready.' }, ...change,
    } }), (error) => {
      assert.ok([400, 409].includes(error.status));
      context = error.laneContext;
      return true;
    });
  }
  const state = JSON.parse(await globalThis.__laneRead({
    pathSegments: ['Interactions', 'By Interaction ID', card.interactionId],
  }));
  assert.equal(state.status, 'active');
  assert.equal(state.pending, null);
  assert.deepEqual(state.values, { topic: { topic: 'nature' } });
  assert.equal(modelRequests.length, previousModels);
  assert.equal(globalThis.__laneFoundry.length, previousFoundry);
});

test('a failed direct transition retains pending input and card Resume processes it once without Foundry', async () => {
  setup();
  const { result: started } = await submit('Collect information.', [
    tools(tool('collect_structured_input', {
      operation: 'start', interactionId: null, specification: buildCollectionTestSpecification(), response: null,
    })), final('Choose a topic.'),
  ]);
  const card = started.interaction;
  const previousModels = modelRequests.length;
  const previousFoundry = globalThis.__laneFoundry.length;
  const mutate = globalThis.__laneMutate;
  let interrupted = false;
  globalThis.__laneMutate = async (options) => {
    if (!interrupted && options.pathSegments.includes(card.interactionId) &&
        JSON.parse(await globalThis.__laneRead(options)).pending) {
      interrupted = true;
      throw new Error('Transition interrupted');
    }
    return mutate(options);
  };
  let recovery;
  await assert.rejects(submit('Nature', [], { interactionSubmission: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    submissionId: 'pending-topic', action: 'continue', values: { topic: 'nature' },
  } }), (error) => {
    assert.match(error.message, /Transition interrupted/);
    context = error.laneContext;
    recovery = error.interaction;
    return true;
  });
  assert.equal(recovery.status, 'pending');
  assert.deepEqual(recovery.allowedActions, ['resume']);
  const resumed = await submitDirectCollectorCard(recovery, 'resume');
  assert.equal(resumed.interaction.stepId, 'note');
  assert.deepEqual(resumed.interaction.collectedValues, { topic: { topic: 'nature' } });
  const again = await submitDirectCollectorCard(resumed.interaction, 'resume');
  assert.equal(again.interaction.stepId, 'note');
  assert.equal(modelRequests.length, previousModels);
  assert.equal(globalThis.__laneFoundry.length, previousFoundry);
});

test('final card Submit is processed before a single model call with all collected values', async () => {
  setup();
  const card = await collectorAtSubmit();
  const previousModels = modelRequests.length;
  const { result } = await submit('Submit', [() => {
    const instruction = modelRequests.at(-1).request.input
      .filter(({ role }) => role === 'system').map(({ content }) => content).join('\n');
    assert.match(instruction, /server already processed.*completed this collection/);
    assert.match(instruction, /collectedValues.*topic.*nature.*note.*Ready/);
    assert.doesNotMatch(instruction, /Call collect_structured_input operation="process"/);
    return final('The collection is complete.');
  }], { interactionSubmission: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    submissionId: 'direct-final-submit', action: 'submit', values: { note: 'Ready.' },
  } });
  assert.equal(modelRequests.length, previousModels + 1);
  assert.equal(result.interaction.status, 'completed');
  assert.deepEqual(result.interaction.collectedValues, { topic: { topic: 'nature' }, note: { note: 'Ready.' } });
  assert.equal(result.agent.name, 'agent');
});

test('a model failure after direct final Submit does not roll back answers or permit replay', async () => {
  setup();
  const card = await collectorAtSubmit();
  await assert.rejects(submit('Submit', [() => { throw new Error('Model unavailable after completion'); }], {
    interactionSubmission: {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
      submissionId: 'committed-final-submit', action: 'submit', values: { note: 'Already saved.' },
    },
  }), (error) => {
    assert.match(error.message, /Model unavailable after completion/);
    assert.equal(error.interaction.status, 'completed');
    assert.deepEqual(error.interaction.allowedActions, []);
    assert.equal(error.interaction.collectedValues.note.note, 'Already saved.');
    context = error.laneContext;
    return true;
  });
  const previousModels = modelRequests.length;
  await assert.rejects(submit('Submit again', [], { interactionSubmission: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    submissionId: 'committed-final-submit', action: 'submit', values: { note: 'Replace saved answer.' },
  } }), { status: 409 });
  assert.equal(modelRequests.length, previousModels);
  const state = JSON.parse(await globalThis.__laneRead({
    pathSegments: ['Interactions', 'By Interaction ID', card.interactionId],
  }));
  assert.equal(state.lastSubmissionId, 'committed-final-submit');
  assert.equal(state.values.note.note, 'Already saved.');
});

test('successful collector Submit releases the same turn for other tools through either response channel', async () => {
  for (const channel of ['card', 'textarea']) {
    setup();
    const card = await collectorAtSubmit();
    const reference = {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    };
    const { result } = await submit('Submit', [
      tools(...(channel === 'textarea' ? [tool('collect_structured_input', {
        operation: 'respond', interactionId: card.interactionId,
        specification: null, response: { action: 'submit', fields: [{ id: 'note', value: 'Ready.', selections: null }] },
      })] : []), tool('search_tree_topics_1', { query: 'nature' })),
      final('Collection completed; search performed.'),
    ], channel === 'card' ? { interactionSubmission: {
      ...reference, submissionId: 'final-submit', action: 'submit', values: { note: 'Ready.' },
    } } : { interactionContext: reference });
    assert.equal(result.interaction.status, 'completed');
    assert.deepEqual(result.interaction.collectedValues, { topic: { topic: 'nature' }, note: { note: 'Ready.' } });
    assert.equal(calls.search, 1);
    assert.equal(calls.save, 0);
    assert.equal(result.laneContext.activeLane, 'knowledge.retrieval');
  }
});

test('completed collector can hand off to a new collector which owns presentation and restricts tools again', async () => {
  setup();
  const card = await collectorAtSubmit();
  const specification = buildCollectionTestSpecification();
  specification.title = 'Follow-up collection';
  specification.steps = specification.steps.slice(1, 2);
  const { result } = await submit('Submit', [
    tools(tool('collect_structured_input', {
      operation: 'start', interactionId: null, specification, response: null,
    }), tool('search_tree_topics_1', { query: 'not allowed while collecting again' })),
    final('Enter a short note.'),
  ], { interactionSubmission: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    submissionId: 'final-submit', action: 'submit', values: { note: 'Ready.' },
  } });
  assert.notEqual(result.interaction.interactionId, card.interactionId);
  assert.equal(result.interaction.title, 'Follow-up collection');
  assert.equal(result.interaction.status, 'active');
  assert.equal(result.interaction.stepId, 'note');
  assert.deepEqual(result.interaction.collectedValues, {});
  assert.equal(calls.search, 0);
});

test('cancellation and reading a previously completed collector do not release turn ownership', async () => {
  for (const action of ['cancel', 'submit']) {
    setup();
    const card = await collectorAtSubmit();
    const { result: ended } = await submit(action, action === 'cancel' ? [] : [
      final('Collection ended.'),
    ], { interactionSubmission: {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
      submissionId: 'end-collection', action, values: action === 'submit' ? { note: 'Ready.' } : {},
    } });
    assert.equal(ended.interaction.status, action === 'submit' ? 'completed' : 'cancelled');
    if (action === 'submit') {
      await submit('Check the collected values.', [
        tools(tool('collect_structured_input', {
          operation: 'status', interactionId: card.interactionId, specification: null, response: null,
        }), tool('search_tree_topics_1', { query: 'status is not a final submission' })),
        final('The collection was already completed.'),
      ]);
    }
    assert.equal(calls.search, 0);
  }
});

test('completion permits lane handoff and normal preview reporting but does not approve saving', async () => {
  for (const attemptSave of [false, true]) {
    setup();
    const card = await collectorAtSubmit();
    const { result } = await submit('Submit', [
      tools(tool('switch_tree_lane', { activeLane: 'knowledge.saving', reason: 'Continue the original request.' }),
      tool('preview_save_to_tree', { content: 'Collected information.' }),
      ...(attemptSave ? [tool('confirm_save_to_tree', { previewId })] : [])),
      attemptSave ? final('The note was not saved; later approval is required.')
        : final(`Save at ${path}?\n\n<!-- Preview ID: ${previewId} -->`, { persistenceAction: 'previewed' }),
    ], { interactionSubmission: {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
      submissionId: 'final-submit', action: 'submit', values: { note: 'Ready.' },
    } });
    assert.equal(result.interaction.status, 'completed');
    assert.equal(result.laneContext.activeLane, 'knowledge.saving');
    assert.equal(result.laneContext.stage, attemptSave ? 'idle' : 'awaiting_approval');
    assert.equal(result.answer, attemptSave ? 'The note was not saved; later approval is required.'
      : `Save at ${path}?\n\n<!-- Preview ID: ${previewId} -->`);
    assert.equal(calls.preview, 1);
    assert.equal(calls.save, 0);
  }
});

test('resuming a pending final Submit can complete the collector and continue in the same turn', async () => {
  setup();
  const card = await collectorAtSubmit();
  const mutate = globalThis.__laneMutate;
  globalThis.__laneMutate = async (options) => {
    if (options.pathSegments.includes(card.interactionId) &&
        JSON.parse(await globalThis.__laneRead(options)).pending) {
      throw new Error('Processing interrupted after capture');
    }
    return mutate(options);
  };
  await assert.rejects(submit('Submit', [], { interactionSubmission: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    submissionId: 'interrupted-final-submit', action: 'submit', values: { note: 'Ready.' },
  } }), /Processing interrupted after capture/);
  globalThis.__laneMutate = mutate;
  context = { conversationId: 'resumed-collector-conversation', version: 0 };
  history = [];
  const { result } = await submit('Resume the submitted collection and continue.', [
    tools(tool('collect_structured_input', {
      operation: 'resume', interactionId: card.interactionId, specification: null, response: null,
    }), tool('search_tree_topics_1', { query: 'nature' })),
    final('The submitted collection was completed and search performed.'),
  ]);
  assert.equal(result.interaction.status, 'completed');
  assert.equal(calls.search, 1);
});

test('an expired conversation is rejected before any model or tool work', async () => {
  setup();
  await submit('Hello', [final('Hello.')]);
  expiredPaths.add(JSON.stringify(['Knowledge Trees', 'Conversations', 'State', context.conversationId]));
  const count = modelRequests.length;
  await assert.rejects(submit('Continue', []), { status: 410, code: 'CHAT_STATE_EXPIRED' });
  assert.equal(modelRequests.length, count);
  assert.deepEqual(calls, { preview: 0, save: 0, search: 0, process: 0 });
});

test('expiry while awaiting the model remains an explicit expiry even if saving failure status also expires', async () => {
  setup();
  await assert.rejects(submit('Hello', [() => {
    expiredPaths.add(JSON.stringify(['Knowledge Trees', 'Conversations', 'State', context.conversationId]));
    return final('Hello.');
  }]), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.status, 410);
    assert.equal(error.code, 'CHAT_STATE_EXPIRED');
    assert.equal(error.errors.length, 2);
    assert.ok(error.errors.every((cause) => cause.status === 410));
    return true;
  });
});

test('real execution preserves retrieval, broadening, preview, later confirmation, and duplicate rejection', async () => {
  setup();
  await submit('What do the notes say?', [
    tools(tool('search_tree_topics_1', { query: 'fish' })),
    final('The notes cover fish. May I answer more broadly?', { isPermissionToBroadenRequest: true }),
  ]);
  await submit('Yes, answer broadly.', [
    final(`${note} Would you like to save this?`, { knowledgeMode: 'broad', isPersistenceOffer: true }),
  ]);
  const previewReply = `Save at ${path}?\n\n<!-- Preview ID: ${previewId} -->`;
  const { result: previewResult } = await submit('Yes, save that answer.', [
    tools(
      tool('switch_tree_lane', { activeLane: 'knowledge.saving', reason: 'The human accepted the save offer.' }),
      tool('preview_save_to_tree', { contentSource: 'prior_broad_answer', broaderAnswer: note }),
    ),
    final(previewReply, { persistenceAction: 'previewed' }),
  ]);
  assert.equal(previewResult.laneContext.stage, 'awaiting_approval');
  assert.equal(calls.save, 0);
  const { request, result } = await submit('Yes, use that destination.', [
    tools(tool('confirm_save_to_tree', { previewId, saveMode: 'create_leaf' })),
    final(`Saved.\n\n${note}\n\n${noteLink}`, { persistenceAction: 'saved' }),
  ]);
  assert.equal(result.laneContext.stage, 'completed');
  assert.equal(result.familyPayload.laneContext.activeLane, 'knowledge.saving');
  const before = modelRequests.length;
  await assert.rejects(invokeKnowledgeTreesAgent(request), { status: 409, message: /already completed/ });
  assert.equal(modelRequests.length, before);
  assert.deepEqual(calls, { search: 1, preview: 1, save: 1, process: 0 });
  assert.ok(modelRequests.every(({ configuration }) => configuration.body.agent.type === 'agent_reference'));
});

test('a same-turn preview cannot be confirmed even when the model queues both calls', async () => {
  setup();
  await submit('Save this factual text.', [
    tools(
      tool('switch_tree_lane', { activeLane: 'knowledge.saving', reason: 'The human requested saving current text.' }),
      tool('preview_save_to_tree', { contentSource: 'current_user_text', broaderAnswer: note }),
      tool('confirm_save_to_tree', { previewId, saveMode: 'create_leaf' }),
    ),
    final('Nothing saved; confirmation requires a later human message.'),
  ]);
  assert.equal(calls.save, 0);
  assert.equal(context.previewId, null);
  const outputs = modelRequests.at(-1).request.input;
  assert.match(JSON.parse(outputs.at(-1).output).error, /later human approval/);
});

test('normal upload completion retains its saving workflow and preview authority requires a later human', async () => {
  setup();
  await submit('Save my attachment.', [
    tools(
      tool('switch_tree_lane', { activeLane: 'knowledge.saving', reason: 'The human attached a file to save.' }),
      tool('process_upload', { uploadId }),
    ),
    final('Processing has started. Nothing saved.', { isWaitingForContinuation: true }),
  ], { uploadId });
  assert.equal(context.stage, 'upload_processing');
  assert.equal(context.uploadId, uploadId);
  await submit('Browser (automated): Upload complete.', [
    tools(tool('preview_save_to_tree', { contentSource: 'completed_upload_note', uploadId })),
    final(`Save at ${path}?\n\n<!-- Preview ID: ${previewId} -->`, { persistenceAction: 'previewed' }),
  ], { previewUploadId: uploadId });
  assert.equal(calls.process, 1);
  assert.equal(calls.preview, 1);
  assert.equal(calls.save, 0);
});

test('a completed upload cannot hijack a newer retrieval workflow', async () => {
  setup();
  await submit('Process this file.', [
    tools(
      tool('switch_tree_lane', { activeLane: 'knowledge.saving', reason: 'The human requested upload processing.' }),
      tool('process_upload', { uploadId }),
    ),
    final('Processing.', { isWaitingForContinuation: true }),
  ], { uploadId });
  const uploadVersion = context.version;
  await submit('Instead, search for fish.', [
    tools(
      tool('switch_tree_lane', { activeLane: 'knowledge.retrieval', reason: 'The human requested a new search.' }),
      tool('search_tree_topics_1', { query: 'fish' }),
    ),
    final('The notes contain fish.'),
  ]);
  const count = modelRequests.length;
  await assert.rejects(invokeKnowledgeTreesAgent(options('Browser (automated): Upload complete.', {
    expectedVersion: uploadVersion, previewUploadId: uploadId,
  })), /state changed/);
  assert.equal(modelRequests.length, count);
  assert.equal(calls.preview, 0);
});
