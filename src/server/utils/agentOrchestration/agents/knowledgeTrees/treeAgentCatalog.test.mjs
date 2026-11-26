import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const modules = new Map([
  ['@/server/utils/tree/treeCatalog', `
    export const getTreeList = async () => [{ id: 1, name: 'Topics', description: 'Stored topic description' }];
    export const updateTreeDescriptionPublishedStates = async () => {};
  `],
  ['@/server/utils/foundryAgentClient', `
    export const AGENT_PREVIEW_FEATURES = {};
    export const getRequiredFoundryConfig = () => globalThis.__treePublishConfig ?? ({ agentName: 'test-agent', modelDeploymentName: 'test-model' });
    export const getRequiredFoundryFamilyConfig = () => ({ agentName: 'test-agent', modelDeploymentName: 'test-model' });
    export const getProjectClient = () => ({ agents: {
      update: async (name, definition) => {
        globalThis.__publishedTreeInstructions = definition.instructions
          .replace(/^(#{2,4}) [345](?:\\.\\d+)+ /gm, '$1 ')
          .replace('## 2.1 Choose whether to stay or switch lanes', '## Choose whether to stay or switch lanes');
        globalThis.__publishedTreeDefinition = definition;
        return { name };
      },
    } });
    export const isNotFoundError = () => false;
    export const deleteProjectPromptAgent = async () => {};
  `],
  ['@/server/utils/agentOrchestration/agents/knowledgeTrees/lanes/retrieval/tools/treeSearchTools', `
    export const buildToolName = () => 'search_tree_topics';
    export const buildTreeSearchToolDefinition = () => ({ name: 'search_tree_topics' });
    export const buildTreeToolPreview = () => [];
    export const createTreeSearchToolHandler = () => {};
  `],
  ['@/server/utils/agentOrchestration/agents/knowledgeTrees/tools/persistenceToolShared', 'export const KNOWLEDGE_TREES_FAMILY = "knowledgeTrees";'],
]);

for (const [moduleName, handlerName, definitionName, toolName] of [
  ['previewAddToTreeTool', 'createPreviewAddToTreeHandler', 'previewAddToTreeToolDefinition', 'preview_save_to_tree'],
  ['reviseTreePreviewTool', 'createReviseTreePreviewHandler', 'reviseTreePreviewToolDefinition', 'revise_save_preview'],
  ['confirmAddToTreeTool', 'createConfirmAddToTreeHandler', 'confirmAddToTreeToolDefinition', 'confirm_save_to_tree'],
  ['processUploadTool', 'createProcessUploadHandler', 'processUploadToolDefinition', 'process_upload'],
]) {
  modules.set(`@/server/utils/agentOrchestration/agents/knowledgeTrees/lanes/saving/tools/${moduleName}`,
    `export const ${handlerName} = () => {}; export const ${definitionName} = { name: "${toolName}" };`);
}

for (const [moduleName, handlerName, definitionName, constantName] of [
  ['email/tools/draftEmailTool', 'buildDraftEmailHandler', 'draftEmailToolDefinition', 'DRAFT_EMAIL_TOOL'],
  ['email/tools/deleteEmailTool', 'buildDeleteEmailHandler', 'deleteEmailToolDefinition', 'DELETE_EMAIL_TOOL'],
  ['email/tools/flagEmailTool', 'buildFlagEmailHandler', 'flagEmailToolDefinition', 'FLAG_EMAIL_TOOL'],
  ['email/tools/showEmailTool', 'buildShowEmailHandler', 'showEmailToolDefinition', 'SHOW_EMAIL_TOOL'],
  ['email/tools/retrieveEmailsTool', 'buildRetrieveEmailsHandler', 'retrieveEmailsToolDefinition', 'RETRIEVE_EMAILS_TOOL'],
  ['email/tools/analyzeEmailTool', 'buildAnalyzeEmailHandler', 'analyzeEmailToolDefinition', 'ANALYZE_EMAIL_TOOL'],
  ['email/tools/sendEmailTool', 'buildSendEmailHandler', 'sendEmailToolDefinition', 'SEND_EMAIL_TOOL'],
  ['email/tools/unsubscribeEmailTool', 'buildUnsubscribeEmailHandler', 'unsubscribeEmailToolDefinition', 'UNSUBSCRIBE_EMAIL_TOOL'],
  ['investment/tools/getBuySellVolatilityRecommendationTool', 'buildGetBuySellVolatilityRecommendationHandler', 'getBuySellVolatilityRecommendationToolDefinition', 'GET_BUY_SELL_VOLATILITY_RECOMMENDATION_TOOL'],
  ['investment/tools/getStockPriceTool', 'buildGetStockPriceHandler', 'getStockPriceToolDefinition', 'GET_STOCK_PRICE_TOOL'],
  ['investment/tools/reviewVolatilityEventsTool', 'buildReviewVolatilityEventsHandler', 'reviewVolatilityEventsToolDefinition', 'GET_VOLATILITY_EVENTS_TOOL'],
  ['investment/tools/updatePortfolioHoldingsTool', 'buildUpdatePortfolioHoldingsHandler', 'updatePortfolioHoldingsToolDefinition', 'PORTFOLIO_STOCK_HOLDINGS_TOOL'],
]) {
  modules.set(`@/server/utils/agentOrchestration/agents/${moduleName}`,
    `export const ${handlerName} = () => {}; export const ${definitionName} = {}; export const ${constantName} = "${constantName}";`);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/server/utils/agentOrchestration/agentConversationInput') {
      return nextResolve(new URL('../../agentConversationInput.js', import.meta.url).href, context);
    }
    if (specifier === '@/server/utils/agentOrchestration/agentToolResult') {
      return nextResolve(new URL('../../agentToolResult.js', import.meta.url).href, context);
    }
    const stub = modules.get(specifier);
    return stub
      ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

const { publishStoredTreeDescriptions, buildAllowedToolInstruction } = await import('./treeAgentCatalog.js');
const { getRequiredFoundryConfig: getActualFoundryConfig } = await import('../../../foundryAgentClient.js');
const { buildReplyLanguagePolicy, buildReplyLanguageInstruction } = await import('../../agentConversationInput.js');
const { buildEmailAgentInstructions } = await import('../email/emailAgentCatalog.js');
const { buildInvestmentAgentInstructions } = await import('../investment/investmentAgentCatalog.js');

test('tool guidance scopes callable tools to the active lane and preserves tree IDs as metadata', () => {
  const trees = [{ id: 1, name: 'Topics' }];
  const enabledToolNames = ['search_tree_topics', 'preview_save_to_tree', 'process_upload', 'quiz',
    'switch_tree_lane', 'collect_structured_input'];
  for (const [activeLane, permitted, forbidden] of [
    ['knowledge.retrieval', 'search_tree_topics', ['quiz', 'process_upload', 'preview_save_to_tree']],
    ['knowledge.saving', 'preview_save_to_tree', ['search_tree_topics', 'quiz']],
    ['quiz', 'quiz', ['search_tree_topics', 'process_upload', 'preview_save_to_tree']],
  ]) {
    const instruction = buildAllowedToolInstruction(trees, { activeLane, enabledToolNames });
    assert.ok(instruction.includes(`- ${permitted}\n`));
    for (const name of forbidden) assert.equal(instruction.includes(`- ${name}\n`), false);
    assert.match(instruction, /treeId=1/);
    assert.match(instruction, /metadata, not permission/);
  }
  const disabled = buildAllowedToolInstruction(trees, {
    activeLane: 'knowledge.saving', enabledToolNames: ['preview_save_to_tree', 'switch_tree_lane'],
  });
  assert.doesNotMatch(disabled, /process_upload/);
});

test('one published agent scopes its numbered leaf lanes and exposes the transition tool', async () => {
  await publishStoredTreeDescriptions();
  const { instructions, tools } = globalThis.__publishedTreeDefinition;
  assert.match(instructions, /^# 1\. Shared rules/m);
  assert.match(instructions, /^# 2\. Lane routing/m);
  assert.match(instructions, /^# 3\. Retrieval \[lane: knowledge\.retrieval\]/m);
  assert.match(instructions, /^# 4\. Saving \[lane: knowledge\.saving\]/m);
  assert.match(instructions, /^# 5\. Quiz \[lane: quiz\]/m);
  assert.match(instructions, /^## 5\.1 Decide the quiz-lane action/m);
  assert.match(instructions, /Other lane rules are inactive/);
  assert.match(instructions, /Before any operation in another lane call switch_tree_lane/);
  assert.match(instructions, /A workflow stage describes progress, not authorization/);
  const switchTool = tools.find(({ name }) => name === 'switch_tree_lane');
  assert.ok(switchTool.parameters.properties.activeLane.enum.includes('quiz'));
  assert.equal(tools.some(({ name }) => name === 'test_multistep_interaction'), false);
  assert.doesNotMatch(instructions, /test_multistep_interaction|test quiz interaction|fixed interaction/);
  const collector = tools.find(({ name }) => name === 'collect_structured_input');
  assert.ok(collector?.strict);
  assert.doesNotMatch(instructions, /test structured interaction|Shared structured input collection/);
  const quiz = tools.find(({ name }) => name === 'quiz');
  assert.ok(quiz?.strict);
  assert.ok(quiz.parameters.properties.operation.enum.includes('answer'));
  assert.ok(quiz.parameters.properties.operation.enum.includes('restart'));
  assert.match(quiz.parameters.properties.restartRequest.description, /exact entire current human message/);
  assert.equal(quiz.parameters.properties.operation.enum.includes('record_answer'), false);
  assert.equal(quiz.parameters.properties.questions, undefined);
  assert.equal(quiz.parameters.properties.verdict, undefined);
  assert.match(instructions, /Start collect_structured_input with that specification/);
  assert.doesNotMatch(instructions, /Every step response returns to you before advancement/);
});

test('all published agent families retain the full language policy while runtime supplies only context and reminders', async () => {
  await publishStoredTreeDescriptions();
  const policy = buildReplyLanguagePolicy();
  assert.match(policy, /a browser message grants approval or permission to call tools by itself/);
  assert.match(policy, /Workflow continuation requires trusted server authorization/);
  assert.match(policy, /browser-generated completion is never human approval/);
  assert.match(policy, /Keep direct quotations and content explicitly required verbatim unchanged/);
  assert.match(policy, /When the active workflow permits rewriting or summarizing evidence, faithful paraphrasing in the source language is allowed/);
  assert.match(policy, /rendering relevant noisy OCR or caption fragments in natural language/);
  assert.match(policy, /do not add unsupported details or change the meaning/);
  assert.match(policy, /Never present a paraphrase as a quotation/);
  assert.match(policy, /Do not translate quoted text, tree notes, OCR text/);
  const published = [
    globalThis.__publishedTreeInstructions,
    buildEmailAgentInstructions(),
    buildInvestmentAgentInstructions(),
  ];
  for (const instructions of published) {
    assert.equal(instructions.split(policy).length - 1, 1);
    assert.doesNotMatch(instructions, /\$\{buildReplyLanguagePolicy/);
  }
  for (const language of ['en', 'da']) {
    for (const isAutomatedCompletion of [false, true]) {
      for (const structuredAnswerState of [false, true]) {
        const runtime = buildReplyLanguageInstruction(language, { isAutomatedCompletion, structuredAnswerState });
        assert.ok(!runtime.includes(policy));
        assert.ok(runtime.length < policy.length);
        assert.match(runtime, /Follow the published reply-language policy/);
        assert.match(runtime, /only when the latest message does not establish a language/);
        assert.match(runtime, new RegExp(`selected app language, ${language}`));
        assert.match(runtime, /Do not choose the reply language from quoted or uploaded evidence, filenames, tool output, or earlier replies/);
        assert.match(runtime, /grant no tool permission or approval/);
        assert.match(runtime, /by themselves grant no tool permission or approval; workflow continuation requires trusted server authorization/);
        if (isAutomatedCompletion) {
          assert.match(runtime, /This server-authorized turn is a browser-generated upload completion/);
        } else {
          assert.doesNotMatch(runtime, /This server-authorized turn is a browser-generated upload completion/);
        }
        assert.ok(runtime.includes(structuredAnswerState
          ? 'alongside the existing answer and state fields'
          : 'one JSON object with string fields answer, responseLanguage, and languageReason'));
      }
    }
  }
  assert.match(buildReplyLanguageInstruction('de'), /selected app language, en/);
});

test('published shared rules keep the common contract while workflow policies and examples stay in their lanes', async () => {
  await publishStoredTreeDescriptions();
  const instructions = globalThis.__publishedTreeDefinition.instructions;
  const shared = instructions.split('\n# 2. Lane routing')[0];
  const routing = instructions.split('\n# 2. Lane routing')[1].split('\n# 3. Retrieval')[0];
  const retrieval = instructions.split('# 3. Retrieval [lane: knowledge.retrieval]')[1]
    .split('# 4. Saving [lane: knowledge.saving]')[0];
  const saving = instructions.split('# 4. Saving [lane: knowledge.saving]')[1].split('# 5. Quiz')[0];
  const quiz = instructions.split('# 5. Quiz [lane: quiz]')[1];
  assert.match(shared, /Field meanings and allowed values/);
  assert.match(shared, /Common clarification outcome/);
  assert.ok(shared.includes(buildReplyLanguagePolicy()));
  assert.doesNotMatch(shared, /Upload evidence and consent|4,000|defaultSavePath|search_tree_\*|Successful confirm_save_to_tree|For a queued upload status reply/);
  assert.doesNotMatch(shared, /isPermissionToBroadenRequest=true|isPersistenceOffer=true|persistenceAction="(?:previewed|revised|saved)"/);
  assert.match(routing, /The server already supplies the active lane/);
  assert.match(routing, /pendingUploadId alone does not make an unrelated message a saving request/);
  assert.match(routing, /^5\. A request to list saved quizzes, start\/resume a quiz, repeat the current quiz question, .* belongs to quiz\./m);
  assert.match(routing, /If the destination matches activeLane, continue there/);
  assert.doesNotMatch(routing, /contentSource=|confirm_save_to_tree|revise_save_preview|process_upload|userClarification|search_tree_\*/);
  assert.match(retrieval, /Decide the retrieval action/);
  assert.match(retrieval, /permission is spent after that answer/);
  assert.match(retrieval, /every substantive question, including follow-ups/);
  assert.match(retrieval, /Grounded answer:.*persistenceAction="none"/);
  assert.match(retrieval, /Permission request after insufficient tree evidence:.*isPermissionToBroadenRequest=true/);
  assert.match(retrieval, /Approved broader answer:.*isPersistenceOffer=true/);
  assert.match(retrieval, /For a normal grounded reply, the shape is:/);
  assert.doesNotMatch(retrieval, /Upload evidence and consent|For a queued upload status reply/);
  assert.doesNotMatch(retrieval, /test_multistep_interaction/);
  assert.doesNotMatch(saving, /test_multistep_interaction/);
  assert.match(quiz, /only when quiz is active/);
  assert.doesNotMatch(quiz, /test_multistep_interaction/);
  assert.match(quiz, /Quizzes use the quiz tool/);
  assert.match(quiz, /The tool grades and returns saved feedback/);
  assert.match(quiz, /The card presents the question and answer options; do not copy, paraphrase or list them in chat/);
  assert.match(quiz, /Let the human expand that review; do not narrate answerReview\.optionExplanations/);
  assert.doesNotMatch(quiz, /explain EVERY option|show saved feedback and the returned next question/);
  assert.match(quiz, /sources -> collect_structured_input for tree selection -> WAIT for human Submit -> sources with setupId -> collect_structured_input for root selection -> WAIT for human Submit -> check saved quizzes -> prepare with setupId -> offer default 25 or a custom size from 1-45 -> WAIT for size choice -> create/);
  assert.match(quiz, /offer Continue \(unfinished\), Take again \(a saved bank exists\), or Generate fresh, and WAIT/);
  assert.match(quiz, /restart the SAME quiz, not create an attempt record/);
  assert.match(quiz, /randomly sample the newly chosen size from the full bank with note coverage first/);
  assert.match(quiz, /Before starting a new quiz or taking one again, offer 25 questions by default with the option to choose any integer from 1 to 45, and WAIT/);
  assert.match(quiz, /Resume never asks for a new size or changes the existing selection, order or progress/);
  assert.match(quiz, /create returns the first question card -> WAIT for human input -> answer or reveal/);
  assert.match(quiz, /show the tool's clarification and returned card -> WAIT for a complete restated human answer -> answer/);
  assert.match(quiz, /preparing -> create; pending captured input -> answer or reveal matching the captured action/);
  assert.match(quiz, /Use question only to re-present the current question card without advancing/);
  assert.doesNotMatch(quiz, /Permission request after insufficient tree evidence:|Successful confirm_save_to_tree:/);
  assert.match(saving, /Upload evidence and consent/);
  assert.match(saving, /Decide the saving action/);
  assert.match(saving, /marker matching previewId in trusted server context/);
  assert.match(saving, /at most 4,000 characters as a verbatim note/);
  assert.match(saving, /Confirmation always requires a later human message/);
  assert.match(saving, /Successful preview_save_to_tree:.*persistenceAction="previewed"/);
  assert.match(saving, /Successful revise_save_preview:.*persistenceAction="revised"/);
  assert.match(saving, /Successful confirm_save_to_tree:.*persistenceAction="saved"/);
  assert.match(saving, /For a queued upload status reply, the shape is:/);
  assert.match(saving, /after a successful confirm_save_to_tree, the shape is:/);
  assert.doesNotMatch(saving, /Permission request after insufficient tree evidence:|Approved broader answer:/);
});

test('publication enables medium reasoning for GPT-5.4 without changing GPT-4.1 tools or instructions', async (t) => {
  const keys = ['AZURE_AI_PROJECT_ENDPOINT', 'AZURE_AI_MODEL_DEPLOYMENT_NAME'];
  const original = keys.map((key) => process.env[key]);
  t.after(() => {
    delete globalThis.__treePublishConfig;
    keys.forEach((key, index) => {
      if (original[index] === undefined) delete process.env[key];
      else process.env[key] = original[index];
    });
  });
  process.env.AZURE_AI_PROJECT_ENDPOINT = 'https://project.example';
  const definitions = [];
  for (const model of ['gpt-4.1', 'gpt-5.4']) {
    process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME = model;
    globalThis.__treePublishConfig = getActualFoundryConfig();
    await publishStoredTreeDescriptions();
    const { model: publishedModel, reasoning, ...rest } = globalThis.__publishedTreeDefinition;
    assert.equal(publishedModel, model);
    if (model === 'gpt-5.4') assert.deepEqual(reasoning, { effort: 'medium' });
    else assert.ok(!Object.hasOwn(globalThis.__publishedTreeDefinition, 'reasoning'));
    definitions.push(rest);
  }
  assert.deepEqual(definitions[0], definitions[1]);
});

test('published prompt exposes Markdown headings, ordered routes, and literal preview markers', async () => {
  await publishStoredTreeDescriptions();
  const instructions = globalThis.__publishedTreeInstructions;
  assert.doesNotMatch(instructions, /^ {4}\S/m);
  const lines = instructions.split('\n');
  for (const [index, line] of lines.entries()) {
    if (/^#{2,4} /.test(line)) {
      if (index > 0 && !/^#{2,4} /.test(lines[index - 1])) {
        assert.equal(lines[index - 1], '', `Blank line before ${line}`);
      }
    }
    if (/^- /.test(line) && !/^(?:- | {2})/.test(lines[index - 1] ?? '')) {
      assert.equal(lines[index - 1], '', `Blank line before list: ${line}`);
    }
    if (/^- /.test(line) && lines[index + 1] && !/^(?:- | {2})/.test(lines[index + 1])) {
      assert.fail(`Missing blank line after list: ${line}`);
    }
  }
  const routing = instructions.split('## Choose whether to stay or switch lanes')[1].split('# 3. Retrieval')[0];
  const retrieval = instructions.split('## Decide the retrieval action')[1].split('## Grounding and broader answers')[0];
  const saving = instructions.split('## Decide the saving action')[1].split('## Response outcomes')[0];
  for (const [section, count] of [[routing, 7], [retrieval, 3], [saving, 7]]) {
    assert.deepEqual([...section.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1])),
      Array.from({ length: count }, (_, index) => index + 1));
  }
  assert.ok(instructions.includes('`<!-- Preview ID: UUID -->`'));
  assert.equal(instructions.split('`\\n\\n<!-- Preview ID: ACTUAL_UUID -->`').length - 1, 2);
});

test('published lane selection and local actions clarify missing intent or content before broadening or searching', async () => {
  await publishStoredTreeDescriptions();
  const instructions = globalThis.__publishedTreeInstructions;
  const routing = instructions.split('## Choose whether to stay or switch lanes')[1].split('# 3. Retrieval')[0];
  const retrieval = instructions.split('## Decide the retrieval action')[1].split('## Grounding and broader answers')[0];
  const saving = instructions.split('## Decide the saving action')[1].split('## Response outcomes')[0];
  assert.match(routing, /^7\. .*stay in the current lane and ask one concise clarification question/m);
  const clarification = saving.match(/^7\. .+$/m)?.[0];
  assert.ok(clarification);
  assert.match(clarification, /current message and applicable conversation context/);
  assert.match(clarification, /ask one concise clarification question/);
  assert.match(clarification, /Do not invent missing information, call tools merely to guess.*or ask permission to broaden/);
  assert.match(clarification, /"save this in tree" without factual text, an authorized upload.*paste the text or attach the file/);
  assert.match(clarification, /Do not ask for content again when an earlier eligible action already identifies it/);
  assert.match(retrieval, /clear question with an unknown answer needs search/);
  assert.match(retrieval, /^2\. If the current message explicitly requests broader knowledge/m);
  assert.match(retrieval, /^3\. Otherwise start grounded/m);
  const outcome = instructions.match(/^- Clarification of an unclear request.+$/m)?.[0];
  assert.ok(outcome);
  assert.match(outcome, /knowledgeMode="grounded", isPermissionToBroadenRequest=false, isPersistenceOffer=false, persistenceAction="none", isWaitingForContinuation=false/);
  assert.match(outcome, /not a substantive knowledge answer/);
});

test('published upload policy checks compatible filename hints before asking for identification', async () => {
  await publishStoredTreeDescriptions();
  const section = globalThis.__publishedTreeInstructions.split('### Completed upload: save intent')[1].split('## Save workflow')[0];
  assert.match(section, /Before deciding whether to ask.*normalized filename topic words together/);
  assert.match(section, /Recognize meaningful terms across languages/);
  assert.match(section, /subject independently supported by the note or caption.*preview directly/);
  assert.match(section, /Ask once.*only when the combined evidence still supports merely a generic subject/);
  assert.doesNotMatch(section, /Before previewing.*proactively ask once|gedde/i);
});

test('published upload policy keeps filename hints out of saved facts and preserves human approval', async () => {
  await publishStoredTreeDescriptions();
  const section = globalThis.__publishedTreeInstructions.split('### Completed upload: save intent')[1].split('## Save workflow')[0];
  assert.match(section, /unverified placement hint, not a confirmed identification/);
  assert.match(section, /Do not add filename-only claims to saved notes or put them in userDescription or userClarification/);
  assert.match(section, /Prefer human descriptions and file content when they conflict/);
  assert.match(section, /If neither human context nor the note or caption supports even a general topic, ask the human/);
  assert.match(section, /processing-only, report completion without previewing or asking/);
  assert.match(section, /Only typed human text can establish an explicitly processing-only request/);
  assert.match(section, /browser's fallback wording is not a processing-only restriction/);
  assert.match(section, /Continue to a preview or the required clarification/);
  assert.match(section, /without asking for details again/);
  assert.match(section, /saving still requires a later human approval of the displayed preview/);
});

test('published confirmation policy copies the latest offered arguments only after human approval', async () => {
  await publishStoredTreeDescriptions();
  const section = globalThis.__publishedTreeInstructions.split('### confirm_save_to_tree')[1].split('## Final response format')[0];
  assert.match(section, /saveMode only from the latest approved preview's availableSaveModes/);
  assert.match(section, /If exactly one mode is offered, use that exact value/);
  assert.match(section, /For an unqualified approval, copy defaultConfirmArguments exactly/);
  assert.match(section, /a revised preview replaces those arguments/);
  assert.match(section, /Never infer the mode from the file type, path wording, or previous previews/);
  assert.match(section, /If mergePath is null.*never request merge_existing/);
  assert.match(section, /must never be used before a later human approves the displayed preview/);
});

test('published save routing distinguishes accepted prior answers from newly supplied facts', async () => {
  await publishStoredTreeDescriptions();
  const instructions = globalThis.__publishedTreeInstructions;
  assert.match(instructions, /accepts the save offer from a specific earlier broad answer.*contentSource="prior_broad_answer"/);
  assert.match(instructions, /supplies new factual text.*contentSource="current_user_text"/);
  assert.match(instructions, /a bare yes is never current_user_text/);
  assert.match(instructions, /do not choose current_user_text or ask the user to repeat an answer available in history/);
  assert.match(instructions, /correct the source and retry the preview without inventing new content or confirming a save/);
  assert.match(instructions, /An intervening broad answer or save offer is not a preview.*new preview of that answer, regardless of earlier previews/);
  assert.match(instructions, /Never invent a previewId/);
  assert.match(instructions, /do not claim expiry unless the tool established it/);
  const preview = instructions.split('### preview_save_to_tree')[1].split('### revise_save_preview')[0];
  assert.match(preview, /Follow the tool's parameter descriptions for exact argument construction/);
  assert.match(preview, /If no substantive text was supplied, ask for it/);
  assert.match(preview, /If the offered answer is unavailable, request a new broad answer/);
  assert.match(preview, /A prior yes to broaden, an isPersistenceOffer=true flag, or an unrelated request is not acceptance/);
  assert.ok(preview.includes('userDescription="" and userClarification="regnbueørred med pink stribe og mørke pletter på krop og hale."'));
  assert.match(preview, /Do not include the language instruction in either factual excerpt/);
});

test('published preview policy does not confuse processing readiness with an approved save', async () => {
  await publishStoredTreeDescriptions();
  const section = globalThis.__publishedTreeInstructions.split('### preview_save_to_tree')[1].split('### revise_save_preview')[0];
  assert.match(section, /Final save approval is not a prerequisite for creating a preview/);
  assert.match(section, /An upload-completion notice.*is not itself a preview/);
  assert.match(section, /call preview_save_to_tree rather than merely reporting that nothing is saved or waiting for final approval/);
  assert.match(section, /Claim a preview is ready only after preview_save_to_tree or revise_save_preview succeeds/);
  assert.match(section, /Processing-only requests still do not authorize a save preview/);
});

test('published preview presentation hides internal modes and avoids duplicate destinations', async () => {
  await publishStoredTreeDescriptions();
  const instructions = globalThis.__publishedTreeInstructions;
  const preview = instructions.split('### preview_save_to_tree')[1].split('### revise_save_preview')[0];
  assert.match(preview, /exact defaultSavePath once/);
  assert.match(preview, /proposed action in ordinary language in the reply language/);
  assert.match(preview, /do not display technical field labels or raw enum values/);
  assert.match(preview, /do not repeat it as a separate merge path/);
  assert.match(preview, /createPath.*only when returned and different from the default destination/);
  assert.doesNotMatch(preview, /Show the tool result's saveKind, defaultSavePath and defaultSaveMode/);
  const revision = instructions.split('### revise_save_preview')[1].split('### confirm_save_to_tree')[0];
  assert.match(revision, /exact revised defaultSavePath once/);
  assert.match(revision, /without displaying technical field labels or raw enum values/);
});

test('published language policy treats standalone ja as Danish before applying the app-language fallback', async () => {
  await publishStoredTreeDescriptions();
  const section = globalThis.__publishedTreeInstructions.split('## Reply language')[1].split('Tool result meta.')[0];
  assert.match(section, /standalone human reply "ja" \(case-insensitive, allowing surrounding whitespace and trailing punctuation\) as Danish/);
  assert.match(section, /set responseLanguage="da", and cite "ja" as the signal in languageReason instead of using the app-language fallback/);
  assert.match(section, /An explicit language request still takes precedence/);
});
