import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const exportsByModule = {
  foundryAgentClient: ['getProjectClient'],
  agentConversationInput: ['buildInitialAgentInput', 'buildReplyLanguageInstruction'],
  agentDebug: ['appendDebugStep', 'attachDebugToError', 'createAgentDebugState', 'serializeDebugValue'],
  agentFamilyExecution: ['runAgentFamilyExecution'],
  agentToolResult: ['getAgentToolResultData', 'getAgentToolResultMeta'],
  treeAgentCatalog: [
    'buildAllowedToolInstruction', 'buildRuntimeTreeToolContext', 'buildVisibilityScopeContext',
    'buildVisibilityScopeInstruction', 'getPublishedKnowledgeTreesPromptAgent',
  ],
  treeAgentResultBuilder: ['buildKnowledgeTreesFamilyResult', 'buildKnowledgeTreesResponse'],
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const name = specifier.split('/').at(-1);
    if (specifier.startsWith('@/') && name === 'agentAnswerState') {
      return nextResolve(new URL('../agentAnswerState.js', import.meta.url).href, context);
    }
    const exports = exportsByModule[name];
    if (specifier.startsWith('@/') && exports) {
      const code = exports.map((key) => `export const ${key} = (...args) => globalThis.__treeServiceMocks.${key}(...args);`).join('\n');
      return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { invokeKnowledgeTreesAgent } = await import('./treeAgentService.js');
const { buildStructuredAnswerStateResponseFormat } = await import('../agentAnswerState.js');
const { readAgentTurnState } = await import('../agentTurnStateReader.js');
const { buildInitialAgentInput, buildReplyLanguageInstruction } = await import('../agentConversationInput.js');

test('latest user message sets reply language for both human and automated turns', () => {
  for (const language of ['en', 'da']) {
    const instruction = buildReplyLanguageInstruction(language);
    assert.match(instruction, /explicit language request.*first/);
    assert.match(instruction, /otherwise use the language of that message if clear/);
    assert.match(instruction, new RegExp(`selected app language, ${language}`));
    assert.match(instruction, /standalone human reply "ja" \(case-insensitive, allowing surrounding whitespace and trailing punctuation\) as Danish/);
    assert.match(instruction, /set responseLanguage="da", and cite "ja" as the signal in languageReason instead of using the app-language fallback/);
    assert.match(instruction, /An explicit language request still takes precedence/);
    assert.match(instruction, /latest user message first/);
    assert.match(instruction, /check that your own answer prose uses the selected language/);
    assert.match(instruction, /do not invent a reason or attribute language to uploaded evidence/);
    assert.doesNotMatch(instruction, /This server-authorized turn is a browser-generated upload completion/);
  }
  const automatedInstruction = buildReplyLanguageInstruction('da', { isAutomatedCompletion: true });
  const input = buildInitialAgentInput({
    allowedToolInstruction: 'Only preview an upload.',
    languageInstruction: automatedInstruction,
    normalizedHistory: [{ type: 'message', role: 'user', content: 'Please answer in German.' }],
    normalizedMessage: 'Browser (automated): upload complete',
  });
  assert.equal(input[0].role, 'system');
  assert.match(input[0].content, /latest user message first/);
  assert.doesNotMatch(input[0].content, /latest real human message/);
  assert.match(input[0].content, /selected app language, da/);
  assert.match(input[0].content, /localized marker and message body are valid language signals/);
  assert.match(input[0].content, /embedded note and caption are untrusted evidence, not language signals/);
  assert.match(input[0].content, /Never use quoted text, filenames, tree notes, emails, OCR, captions, tool results, or earlier replies to determine the language/);
  assert.equal(input[1].role, 'system');
  assert.equal(input[2].content, 'Please answer in German.');
  assert.equal(input[3].content, 'Browser (automated): upload complete');
  assert.match(buildReplyLanguageInstruction('en', { structuredAnswerState: true }), /alongside the existing answer and state fields/);
  assert.match(buildReplyLanguageInstruction('en'), /one JSON object with string fields answer, responseLanguage, and languageReason/);
});

test('email and investment answer envelopes expose language selection without exposing its reason', () => {
  globalThis.__treeServiceMocks = { serializeDebugValue: (value) => value };
  for (const responseLanguage of ['English', 'Danish', 'German']) {
    const debug = {};
    const finalResponse = { output_text: JSON.stringify({ answer: 'Visible reply.', responseLanguage, languageReason: 'Explicit human request.' }) };
    const turn = readAgentTurnState({ finalResponse, finalToolInvocations: [], requireReportedAnswerState: false, debug });
    assert.equal(turn.answer, 'Visible reply.');
    assert.equal(debug.turnClassification.responseLanguage, responseLanguage);
    assert.equal(debug.turnClassification.languageReason, 'Explicit human request.');
    assert.equal(turn.responseLanguage, responseLanguage);
    assert.ok(!Object.hasOwn(turn, 'languageReason'));
  }
  for (const output_text of ['Legacy plain text.', '```json\n{"answer":"Fenced reply.","responseLanguage":"da","languageReason":"App fallback."}\n```']) {
    const turn = readAgentTurnState({ finalResponse: { output_text }, finalToolInvocations: [], requireReportedAnswerState: false });
    assert.equal(turn.answer, output_text.startsWith('Legacy') ? 'Legacy plain text.' : 'Fenced reply.');
  }
});

test('only the Knowledge Trees response format requires persistence and waiting fields', () => {
  const treeSchema = buildStructuredAnswerStateResponseFormat({ requirePersistenceAction: true, requireWaitingForContinuation: true }).format.schema;
  const defaultSchema = buildStructuredAnswerStateResponseFormat().format.schema;
  assert.ok(treeSchema.required.includes('persistenceAction'));
  assert.ok(treeSchema.required.includes('isWaitingForContinuation'));
  assert.ok(treeSchema.required.includes('responseLanguage'));
  assert.ok(treeSchema.required.includes('languageReason'));
  assert.match(treeSchema.properties.languageReason.description, /latest user message \(including a browser-generated completion\)/);
  assert.equal(treeSchema.properties.isWaitingForContinuation.type, 'boolean');
  assert.deepEqual(treeSchema.properties.persistenceAction.enum, ['none', 'previewed', 'revised', 'saved']);
  assert.ok(!defaultSchema.required.includes('persistenceAction'));
  assert.ok(!defaultSchema.required.includes('isWaitingForContinuation'));
  assert.ok(!Object.hasOwn(treeSchema.properties, 'shouldPreviewUploadedNote'));
});

test('a tree reply with no language reason requests correction before accepting the preview', async () => {
  const validator = await getValidator();
  const response = savedResponse('Preview ready.');
  const parsed = JSON.parse(response.output_text);
  parsed.languageReason = '';
  response.output_text = JSON.stringify(parsed);
  const correction = await validator({ response, toolInvocations: [] });
  assert.match(correction, /non-empty responseLanguage and languageReason/);
  assert.match(correction, /rewrite your prose if needed/);
  assert.match(correction, /do not call the preview tool again/);
});

test('automated preview rejects a language report that conflicts with its localized message', async () => {
  const uploadId = 'c125d350-4cae-4ad4-a69c-419324125e00';
  const validator = await getValidator(null, uploadId, 'Browser (automated): The upload has finished processing.');
  const response = savedResponse('Forhåndsvisning klar.', 'The upload was previewed.', 'none');
  const parsed = JSON.parse(response.output_text);
  parsed.responseLanguage = 'da';
  parsed.languageReason = 'Upload-note er på dansk.';
  response.output_text = JSON.stringify(parsed);
  const correction = await validator({ response, toolInvocations: [] });
  assert.match(correction, /browser-generated message is in en, but you reported responseLanguage="da"/);
  assert.match(correction, /Do not use the uploaded note to choose the reply language/);
  assert.match(correction, /do not call the preview tool again/);

  parsed.responseLanguage = 'en';
  parsed.languageReason = 'The latest message is in English.';
  response.output_text = JSON.stringify(parsed);
  assert.equal(await validator({ response, toolInvocations: [] }), null);

  const danishValidator = await getValidator(null, uploadId, 'Browser (automatisk): Uploaden er færdigbehandlet.');
  parsed.responseLanguage = 'Danish';
  response.output_text = JSON.stringify(parsed);
  assert.equal(await danishValidator({ response, toolInvocations: [] }), null);
  parsed.responseLanguage = 'en';
  response.output_text = JSON.stringify(parsed);
  assert.match(await danishValidator({ response, toolInvocations: [] }), /browser-generated message is in da/);
});

async function getValidator(uploadId = null, previewUploadId = null, message = 'Yes, save it.', {
  history = [], pendingUploadId = null, handlerMap = null, runExecution = null,
} = {}) {
  let validator;
  globalThis.__treeServiceMocks = {
    appendDebugStep: () => {},
    attachDebugToError: (error) => error,
    getProjectClient: () => ({ getOpenAIClient: () => ({}) }),
    getPublishedKnowledgeTreesPromptAgent: async () => ({ name: 'test-agent' }),
    buildRuntimeTreeToolContext: async () => ({ handlerMap: handlerMap ?? new Map(['process_upload', 'preview_save_to_tree', 'revise_save_preview', 'confirm_save_to_tree'].map((name) => [name, () => {}])), toolPolicies: new Map(), includedTrees: [] }),
    buildVisibilityScopeContext: () => ({}),
    buildVisibilityScopeInstruction: () => '',
    buildAllowedToolInstruction: () => '',
    buildInitialAgentInput,
    buildReplyLanguageInstruction: () => '',
    runAgentFamilyExecution: async (options) => {
      if (previewUploadId) assert.deepEqual([...options.handlerMap.keys()], ['preview_save_to_tree', 'confirm_save_to_tree']);
      validator = options.finalResponseValidator;
      await runExecution?.(options);
      return { response: {}, toolInvocations: [], modelCalls: [] };
    },
    buildKnowledgeTreesFamilyResult: async () => ({ familyResult: {} }),
    buildKnowledgeTreesResponse: () => ({}),
  };
  await invokeKnowledgeTreesAgent({ message, history, uploadId, previewUploadId, pendingUploadId });
  return validator;
}

function savedResponse(answer, explanation = 'Reporting the note saved by confirm_save_to_tree.', persistenceAction = 'saved', isWaitingForContinuation = false) {
  return {
    output_text: JSON.stringify({
      answer,
      knowledgeMode: 'grounded',
      isPermissionToBroadenRequest: false,
      isPersistenceOffer: false,
      explanation,
      responseLanguage: 'English',
      languageReason: 'The latest human message is in English.',
      persistenceAction,
      isWaitingForContinuation,
    }),
  };
}

test('persistence action appears beside the Knowledge Trees debug classification fields only', () => {
  globalThis.__treeServiceMocks = { serializeDebugValue: (value) => value };
  const treeDebug = {};
  readAgentTurnState({
    finalResponse: savedResponse('Saved.'),
    finalToolInvocations: [],
    answerStateOptions: { requirePersistenceAction: true, requireWaitingForContinuation: true },
    debug: treeDebug,
  });
  assert.equal(treeDebug.turnClassification.persistenceAction, 'saved');
  assert.equal(treeDebug.turnClassification.isWaitingForContinuation, false);
  assert.equal(treeDebug.turnClassification.knowledgeMode, 'grounded');
  assert.equal(treeDebug.turnClassification.responseLanguage, 'English');
  assert.match(treeDebug.turnClassification.languageReason, /latest human message/);

  const defaultDebug = {};
  readAgentTurnState({
    finalResponse: savedResponse('Saved.'),
    finalToolInvocations: [],
    debug: defaultDebug,
  });
  assert.ok(!Object.hasOwn(defaultDebug.turnClassification, 'persistenceAction'));
  assert.ok(!Object.hasOwn(defaultDebug.turnClassification, 'isWaitingForContinuation'));
});

test('a preview result cannot be presented as a completed save', async () => {
  const validator = await getValidator();
  const error = await validator({
    response: savedResponse('I saved the note.'),
    toolInvocations: [{ toolName: 'preview_save_to_tree', output: { toolResultType: 'tree_note_preview', data: { previewId: 'test' } } }],
  });
  assert.match(error, /persistenceAction="previewed"/);
});

test('a preview must report its actual destination and marker before confirmation', async () => {
  const validator = await getValidator();
  const toolInvocations = [{
    toolName: 'preview_save_to_tree',
    output: { toolResultType: 'tree_note_preview', data: { previewId: 'test-id', defaultSavePath: 'geometri > Rumfang' } },
  }];
  assert.match(await validator({ response: savedResponse('Saved.'), toolInvocations }), /persistenceAction="previewed"/);
  assert.match(await validator({
    response: savedResponse('Wrong destination?', 'Reporting the preview from preview_save_to_tree.', 'previewed'),
    toolInvocations,
  }), /exact Preview ID marker/);
  const response = savedResponse('Merge at geometri > Rumfang?\n\n<!-- Preview ID: test-id -->', 'Reporting the preview from preview_save_to_tree.', 'previewed');
  assert.equal(await validator({ response, toolInvocations }), null);
});

test('an upload preview must display the entire frozen incoming notes block', async () => {
  const validator = await getValidator();
  const incomingNotes = 'User description:\nA river\n\nGenerated image caption:\nA trout';
  const toolInvocations = [{ toolName: 'preview_save_to_tree', output: { toolResultType: 'tree_note_preview', data: {
    previewId: 'test-id', defaultSavePath: 'Knowledge > Trout', incomingNotes,
  } } }];
  const reply = (text) => savedResponse(`${text}\n\n<!-- Preview ID: test-id -->`, 'Reporting the upload preview.', 'previewed');
  assert.match(await validator({ response: reply('Knowledge > Trout?'), toolInvocations }), /complete incomingNotes block/);
  assert.equal(await validator({ response: reply(`Knowledge > Trout?\n\n${incomingNotes}`), toolInvocations }), null);
});

test('a failed confirm cannot be presented as a completed save', async () => {
  const validator = await getValidator();
  const error = await validator({
    response: savedResponse('I saved the note.'),
    toolInvocations: [{ toolName: 'confirm_save_to_tree', output: { error: 'Preview expired' } }],
  });
  assert.match(error, /persistenceAction="none"/);
  assert.match(error, /Do not call confirm_save_to_tree: no preview is eligible/);
  assert.match(error, /call preview_save_to_tree with contentSource="prior_broad_answer" now/);
  assert.match(error, /rewrite answer and explanation/);
  assert.match(error, /note was not saved/);
});

test('accepting a new broad answer cannot confirm an older or invented preview ID', async () => {
  const oldId = 'c125d350-4cae-4ad4-a69c-419324125e00';
  const fakeId = 'deafbeef-0000-4000-8000-000000000000';
  let confirms = 0;
  const previewArguments = [];
  const validator = await getValidator(null, null, 'Yes, save that answer.', {
    history: [
      { role: 'assistant', content: `Place the uploaded file here?\n\n<!-- Preview ID: ${oldId} -->` },
      { role: 'user', content: 'Give me a broader answer about catching this fish instead.' },
      { role: 'assistant', content: 'A new broad answer about fishing. Would you like to save this answer?' },
    ],
    handlerMap: new Map([
      ['confirm_save_to_tree', async () => { confirms += 1; }],
      ['preview_save_to_tree', async (args) => { previewArguments.push(args); return {}; }],
    ]),
    runExecution: async ({ handlerMap, initialInput }) => {
      const instruction = initialInput.find(({ role }) => role === 'system').content;
      assert.match(instruction, /Do not call confirm_save_to_tree or invent a previewId/);
      assert.match(instruction, /even when an older preview exists in history/);
      for (const previewId of [oldId, fakeId]) {
        await assert.rejects(handlerMap.get('confirm_save_to_tree')({ previewId, saveMode: 'create_leaf' }),
          /call preview_save_to_tree now with contentSource="prior_broad_answer"/);
      }
      await handlerMap.get('preview_save_to_tree')({
        contentSource: 'prior_broad_answer', broaderAnswer: 'A new broad answer about fishing.',
      });
    },
  });
  assert.equal(confirms, 0);
  assert.deepEqual(previewArguments, [{
    contentSource: 'prior_broad_answer', broaderAnswer: 'A new broad answer about fishing.',
  }]);
  const correction = await validator({
    response: savedResponse('Saved.'), toolInvocations: [],
  });
  assert.match(correction, /Do not call confirm_save_to_tree/);
  assert.doesNotMatch(correction, /call confirm_save_to_tree with/);
});

test('confirmation accepts only the immediately displayed ID and preserves the handler result', async () => {
  const oldId = 'c125d350-4cae-4ad4-a69c-419324125e00';
  const latestId = '60b8daca-abcd-4321-8000-000000000001';
  const calls = [];
  const result = { toolResultType: 'tree_note_created' };
  await getValidator(null, null, 'Yes, use that revised path.', {
    history: [
      { role: 'assistant', content: `Old path?\n\n<!-- Preview ID: ${oldId} -->` },
      { role: 'user', content: 'Change the path.' },
      { role: 'assistant', content: `Revised path?\n\n<!-- Preview ID: ${latestId} -->` },
    ],
    handlerMap: new Map([['confirm_save_to_tree', async (...args) => { calls.push(args); return result; }]]),
    runExecution: async ({ handlerMap }) => {
      const confirm = handlerMap.get('confirm_save_to_tree');
      await assert.rejects(confirm({ previewId: oldId, saveMode: 'create_leaf' }), /does not match/);
      await assert.rejects(confirm({ previewId: 'made-up', saveMode: 'create_leaf' }), /does not match/);
      const args = { previewId: latestId, saveMode: 'create_leaf' };
      const context = { trace: 'test' };
      assert.equal(await confirm(args, context), result);
      assert.deepEqual(calls, [[args, context]]);
    },
  });
});

test('creating or revising a preview prevents confirmation in the same human turn', async () => {
  const previewId = 'c125d350-4cae-4ad4-a69c-419324125e00';
  for (const tool of ['preview_save_to_tree', 'revise_save_preview']) {
    let confirms = 0;
    await getValidator(null, null, 'Use another path.', {
      history: [{ role: 'assistant', content: `Preview?\n\n<!-- Preview ID: ${previewId} -->` }],
      handlerMap: new Map([
        [tool, async () => ({ toolResultType: 'tree_note_preview' })],
        ['confirm_save_to_tree', async () => { confirms += 1; }],
      ]),
      runExecution: async ({ handlerMap, finalResponseValidator }) => {
        await handlerMap.get(tool)({});
        await assert.rejects(handlerMap.get('confirm_save_to_tree')({ previewId, saveMode: 'create_leaf' }),
          /preview created in this turn requires later human approval/);
        const correction = await finalResponseValidator({ response: savedResponse('Saved.'), toolInvocations: [] });
        assert.match(correction, /Do not call confirm_save_to_tree/);
      },
    });
    assert.equal(confirms, 0);
  }
});

test('upload turns cannot use a prior preview marker as human save approval', async () => {
  const id = 'c125d350-4cae-4ad4-a69c-419324125e00';
  for (const turn of [{ uploadId: id }, { previewUploadId: id }, { pendingUploadId: id }]) {
    let confirms = 0;
    await getValidator(turn.uploadId, turn.previewUploadId, 'Yes.', {
      pendingUploadId: turn.pendingUploadId,
      history: [{ role: 'assistant', content: `Preview?\n\n<!-- Preview ID: ${id} -->` }],
      handlerMap: new Map([
        ['preview_save_to_tree', async () => ({})],
        ['confirm_save_to_tree', async () => { confirms += 1; }],
      ]),
      runExecution: async ({ handlerMap }) => {
        await assert.rejects(handlerMap.get('confirm_save_to_tree')({ previewId: id, saveMode: 'create_leaf' }),
          /Confirmation is not authorized in this turn/);
      },
    });
    assert.equal(confirms, 0);
  }
});

test('a failed confirm after a preview cannot claim the preview or a save', async () => {
  const validator = await getValidator();
  const toolInvocations = [
    { toolName: 'preview_save_to_tree', output: { toolResultType: 'tree_note_preview', data: { previewId: 'old-id', defaultSavePath: 'geometri > Rumfang' } } },
    { toolName: 'confirm_save_to_tree', output: { error: 'Preview expired' } },
  ];
  assert.match(await validator({ response: savedResponse('Saved.'), toolInvocations }), /persistenceAction="none"/);
  assert.match(await validator({
    response: savedResponse('Previewed.', 'Reporting the preview from preview_save_to_tree.', 'previewed'), toolInvocations,
  }), /persistenceAction="none"/);
});

test('missing action field is rejected, and a turn without persistence has none', async () => {
  const validator = await getValidator();
  const response = savedResponse('No note was saved.', 'Answered from tree tool evidence.', 'none');
  assert.equal(await validator({ response, toolInvocations: [] }), null);
  const missingAction = JSON.parse(response.output_text);
  delete missingAction.persistenceAction;
  assert.match(await validator({ response: { output_text: JSON.stringify(missingAction) }, toolInvocations: [] }), /Invalid persistenceAction/);
  assert.match(await validator({ response: savedResponse('Saved.'), toolInvocations: [] }), /persistenceAction="none"/);
});

test('waiting is the agent decision, not inferred from upload status', async () => {
  const validator = await getValidator();
  const waitingResponse = savedResponse('I will continue.', 'Waiting for the next turn.', 'none', true);
  assert.equal(await validator({ response: waitingResponse, toolInvocations: [] }), null);
  assert.equal(readAgentTurnState({
    finalResponse: waitingResponse,
    finalToolInvocations: [],
    answerStateOptions: { requirePersistenceAction: true, requireWaitingForContinuation: true },
  }).isWaitingForContinuation, true);
  const missingWaiting = JSON.parse(savedResponse('Not waiting.', 'Finished.', 'none').output_text);
  delete missingWaiting.isWaitingForContinuation;
  assert.match(await validator({ response: { output_text: JSON.stringify(missingWaiting) }, toolInvocations: [] }), /Invalid isWaitingForContinuation/);
  assert.match(await validator({ response: savedResponse('Not waiting.', 'Finished.', 'none', 'false'), toolInvocations: [] }), /Invalid isWaitingForContinuation/);
  const uploadId = 'c125d350-4cae-4ad4-a69c-419324125e00';
  const uploadValidator = await getValidator(uploadId);
  const queuedUpload = [{ toolName: 'process_upload', output: { toolResultType: 'temporary_upload_note', data: { uploadId, status: 'queued' } } }];
  assert.equal(await uploadValidator({ response: savedResponse('Processing.', 'Reporting status.', 'none', false), toolInvocations: queuedUpload }), null);
});

test('an attached upload requires a successful process_upload call before replying', async () => {
  const uploadId = 'c125d350-4cae-4ad4-a69c-419324125e00';
  const validator = await getValidator(uploadId);
  const response = savedResponse('Processing is underway.', 'Reporting the upload status.', 'none');
  assert.match(await validator({ response, toolInvocations: [] }), /Call process_upload/);
  assert.match(await validator({ response, toolInvocations: [{ toolName: 'process_upload', output: { error: 'Queue unavailable' } }] }), /Call process_upload/);
  assert.equal(await validator({
    response,
    toolInvocations: [{ toolName: 'process_upload', output: { toolResultType: 'temporary_upload_note', data: { uploadId, status: 'queued' } } }],
  }), null);
});

test('a revised preview requires revised status and its latest destination', async () => {
  const validator = await getValidator();
  const toolInvocations = [{
    toolName: 'revise_save_preview',
    output: { toolResultType: 'tree_note_preview', data: { previewId: 'new-id', defaultSavePath: 'geometri > New note' } },
  }];
  assert.match(await validator({
    response: savedResponse('New preview.', 'Reporting the revised preview from revise_save_preview.', 'previewed'), toolInvocations,
  }), /persistenceAction="revised"/);
  assert.equal(await validator({
    response: savedResponse('Create at geometri > New note?\n\n<!-- Preview ID: new-id -->', 'Reporting the revised preview from revise_save_preview.', 'revised'),
    toolInvocations,
  }), null);
});

test('successful confirm requires the returned note and link verbatim', async () => {
  const validator = await getValidator();
  const toolInvocations = [{
    toolName: 'confirm_save_to_tree',
    output: {
      toolResultType: 'tree_note_updated',
      data: { noteLink: '[View note](/notes?treeId=29&nodeId=4)', details: { notes: 'The prism has volume 12.' } },
    },
  }];
  assert.match(await validator({ response: savedResponse('Saved a different note.'), toolInvocations }), /exact noteLink and complete details.notes/);
  assert.equal(await validator({
    response: savedResponse('The prism has volume 12. [View note](/notes?treeId=29&nodeId=4)'),
    toolInvocations,
  }), null);
});

test('completed upload turn can report completion without preview and instructs against confirmation', async () => {
  const validator = await getValidator(null, 'c125d350-4cae-4ad4-a69c-419324125e00');
  const response = savedResponse('Processing complete.', 'Reporting upload status.', 'none');
  assert.equal(await validator({ response, toolInvocations: [] }), null);
  assert.equal(await validator({ response, toolInvocations: [{ toolName: 'preview_save_to_tree', output: { error: 'Not ready' } }] }), null);
  assert.equal(await validator({
    response: savedResponse('Preview at geometri > Rumfang?\n\n<!-- Preview ID: test-id -->', 'Reporting the preview.', 'previewed'),
    toolInvocations: [{ toolName: 'preview_save_to_tree', output: { toolResultType: 'tree_note_preview', data: { previewId: 'test-id', defaultSavePath: 'geometri > Rumfang' } } }],
  }), null);
  const toolInvocations = [{
    toolName: 'preview_save_to_tree',
    output: { toolResultType: 'tree_note_preview', data: { previewId: 'test-id', defaultSavePath: 'Knowledge > Note' } },
  }];
  assert.equal(await validator({
    response: savedResponse('Place at Knowledge > Note?\n\n<!-- Preview ID: test-id -->', 'Reporting the upload preview.', 'previewed'),
    toolInvocations,
  }), null);

  const handlerMap = new Map([
    ['preview_save_to_tree', () => {}], ['process_upload', () => {}],
    ['revise_save_preview', () => {}], ['confirm_save_to_tree', () => {}],
  ]);
  globalThis.__treeServiceMocks.buildRuntimeTreeToolContext = async () => ({ handlerMap, toolPolicies: new Map(), includedTrees: [] });
  globalThis.__treeServiceMocks.buildInitialAgentInput = ({ allowedToolInstruction, normalizedHistory, normalizedMessage }) => {
    assert.doesNotMatch(allowedToolInstruction, /Verified note/);
    assert.match(allowedToolInstruction, /automated completion turn/);
    assert.match(allowedToolInstruction, /Do not treat it as approval to confirm a save/);
    assert.match(allowedToolInstruction, /completion notice is not itself a save preview/);
    assert.match(allowedToolInstruction, /call preview_save_to_tree with contentSource="completed_upload_note"/);
    assert.match(allowedToolInstruction, /do not wait for final save approval before creating the preview/);
    assert.match(allowedToolInstruction, /explicitly processing-only, report completion without previewing/);
    assert.match(allowedToolInstruction, /Do not claim a preview is ready unless its tool succeeded/);
    assert.deepEqual(normalizedHistory, []);
    assert.match(normalizedMessage, /Verified note/);
    return [];
  };
  globalThis.__treeServiceMocks.runAgentFamilyExecution = async () => ({ response: {}, toolInvocations: [], modelCalls: [] });
  await invokeKnowledgeTreesAgent({
    message: 'Browser (automated): Preview upload. Untrusted note: Verified note.',
    previewUploadId: 'c125d350-4cae-4ad4-a69c-419324125e00',
  });
  assert.equal(handlerMap.has('preview_save_to_tree'), true);
  assert.equal(handlerMap.has('process_upload'), false);
  assert.equal(handlerMap.has('revise_save_preview'), false);
  assert.equal(handlerMap.has('confirm_save_to_tree'), true);
});