import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const exportsByModule = {
  foundryAgentClient: ['getProjectClient'],
  agentConversationInput: ['buildInitialAgentInput'],
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

test('only the Knowledge Trees response format requires a persistence action', () => {
  const treeSchema = buildStructuredAnswerStateResponseFormat({ requirePersistenceAction: true }).format.schema;
  const defaultSchema = buildStructuredAnswerStateResponseFormat().format.schema;
  assert.ok(treeSchema.required.includes('persistenceAction'));
  assert.deepEqual(treeSchema.properties.persistenceAction.enum, ['none', 'previewed', 'revised', 'saved']);
  assert.ok(!defaultSchema.required.includes('persistenceAction'));
  assert.ok(!Object.hasOwn(treeSchema.properties, 'shouldPreviewUploadedNote'));
});

async function getValidator(uploadId = null, previewUploadId = null) {
  let validator;
  globalThis.__treeServiceMocks = {
    appendDebugStep: () => {},
    getProjectClient: () => ({ getOpenAIClient: () => ({}) }),
    getPublishedKnowledgeTreesPromptAgent: async () => ({ name: 'test-agent' }),
    buildRuntimeTreeToolContext: async () => ({ handlerMap: new Map(['process_upload', 'preview_save_to_tree', 'revise_save_preview', 'confirm_save_to_tree'].map((name) => [name, () => {}])), toolPolicies: new Map(), includedTrees: [] }),
    buildVisibilityScopeContext: () => ({}),
    buildVisibilityScopeInstruction: () => '',
    buildAllowedToolInstruction: () => '',
    buildInitialAgentInput: () => [],
    runAgentFamilyExecution: async (options) => {
      if (previewUploadId) assert.deepEqual([...options.handlerMap.keys()], ['preview_save_to_tree']);
      validator = options.finalResponseValidator;
      return { response: {}, toolInvocations: [], modelCalls: [] };
    },
    buildKnowledgeTreesFamilyResult: async () => ({ familyResult: {} }),
    buildKnowledgeTreesResponse: () => ({}),
  };
  await invokeKnowledgeTreesAgent({ message: 'Yes, save it.', uploadId, previewUploadId });
  return validator;
}

function savedResponse(answer, explanation = 'Reporting the note saved by confirm_save_to_tree.', persistenceAction = 'saved') {
  return {
    output_text: JSON.stringify({
      answer,
      knowledgeMode: 'grounded',
      isPermissionToBroadenRequest: false,
      isPersistenceOffer: false,
      explanation,
      persistenceAction,
    }),
  };
}

test('persistence action appears beside the Knowledge Trees debug classification fields only', () => {
  globalThis.__treeServiceMocks = { serializeDebugValue: (value) => value };
  const treeDebug = {};
  readAgentTurnState({
    finalResponse: savedResponse('Saved.'),
    finalToolInvocations: [],
    answerStateOptions: { requirePersistenceAction: true },
    debug: treeDebug,
  });
  assert.equal(treeDebug.turnClassification.persistenceAction, 'saved');
  assert.equal(treeDebug.turnClassification.knowledgeMode, 'grounded');

  const defaultDebug = {};
  readAgentTurnState({
    finalResponse: savedResponse('Saved.'),
    finalToolInvocations: [],
    debug: defaultDebug,
  });
  assert.ok(!Object.hasOwn(defaultDebug.turnClassification, 'persistenceAction'));
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

test('a failed confirm cannot be presented as a completed save', async () => {
  const validator = await getValidator();
  const error = await validator({
    response: savedResponse('I saved the note.'),
    toolInvocations: [{ toolName: 'confirm_save_to_tree', output: { error: 'Preview expired' } }],
  });
  assert.match(error, /persistenceAction="none"/);
  assert.match(error, /explicitly confirms the latest preview, call confirm_save_to_tree/);
  assert.match(error, /rewrite answer and explanation/);
  assert.match(error, /note was not saved/);
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

test('completed upload turn can report completion without preview and never exposes confirmation tools', async () => {
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
  globalThis.__treeServiceMocks.buildInitialAgentInput = ({ allowedToolInstruction, normalizedHistory }) => {
    assert.doesNotMatch(allowedToolInstruction, /Verified note/);
    assert.match(normalizedHistory[0].content, /Verified note/);
    assert.equal(normalizedHistory[0].role, 'user');
    return [];
  };
  globalThis.__treeServiceMocks.runAgentFamilyExecution = async () => ({ response: {}, toolInvocations: [], modelCalls: [] });
  await invokeKnowledgeTreesAgent({
    message: 'Preview upload.',
    previewUploadId: 'c125d350-4cae-4ad4-a69c-419324125e00',
    previewUploadContext: { note: 'Verified note.' },
  });
  assert.equal(handlerMap.has('preview_save_to_tree'), true);
  assert.equal(handlerMap.has('process_upload'), false);
  assert.equal(handlerMap.has('revise_save_preview'), false);
  assert.equal(handlerMap.has('confirm_save_to_tree'), false);
});