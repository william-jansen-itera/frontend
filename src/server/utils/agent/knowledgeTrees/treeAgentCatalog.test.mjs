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
        globalThis.__publishedTreeInstructions = definition.instructions;
        globalThis.__publishedTreeDefinition = definition;
        return { name };
      },
    } });
    export const isNotFoundError = () => false;
    export const deleteProjectPromptAgent = async () => {};
  `],
  ['@/server/utils/agent/knowledgeTrees/tools/treeSearchTools', `
    export const buildToolName = () => 'search_tree_topics';
    export const buildTreeSearchToolDefinition = () => ({ name: 'search_tree_topics' });
    export const buildTreeToolPreview = () => [];
    export const createTreeSearchToolHandler = () => {};
  `],
  ['@/server/utils/agent/knowledgeTrees/tools/persistenceToolShared', 'export const KNOWLEDGE_TREES_FAMILY = "knowledgeTrees";'],
]);

for (const [moduleName, handlerName, definitionName, toolName] of [
  ['previewAddToTreeTool', 'createPreviewAddToTreeHandler', 'previewAddToTreeToolDefinition', 'preview_save_to_tree'],
  ['reviseTreePreviewTool', 'createReviseTreePreviewHandler', 'reviseTreePreviewToolDefinition', 'revise_save_preview'],
  ['confirmAddToTreeTool', 'createConfirmAddToTreeHandler', 'confirmAddToTreeToolDefinition', 'confirm_save_to_tree'],
  ['processUploadTool', 'createProcessUploadHandler', 'processUploadToolDefinition', 'process_upload'],
]) {
  modules.set(`@/server/utils/agent/knowledgeTrees/tools/${moduleName}`,
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
  modules.set(`@/server/utils/agent/${moduleName}`,
    `export const ${handlerName} = () => {}; export const ${definitionName} = {}; export const ${constantName} = "${constantName}";`);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/server/utils/agent/agentConversationInput') {
      return nextResolve(new URL('../agentConversationInput.js', import.meta.url).href, context);
    }
    const stub = modules.get(specifier);
    return stub
      ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

const { publishStoredTreeDescriptions } = await import('./treeAgentCatalog.js');
const { getRequiredFoundryConfig: getActualFoundryConfig } = await import('../../foundryAgentClient.js');
const { buildReplyLanguagePolicy, buildReplyLanguageInstruction } = await import('../agentConversationInput.js');
const { buildEmailAgentInstructions } = await import('../email/emailAgentCatalog.js');
const { buildInvestmentAgentInstructions } = await import('../investment/investmentAgentCatalog.js');

test('all published agent families and runtime messages retain the same complete language policy', async () => {
  await publishStoredTreeDescriptions();
  const policy = buildReplyLanguagePolicy();
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
        assert.equal(runtime.split(policy).length - 1, 1);
        assert.match(runtime, new RegExp(`selected app language, ${language}`));
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
  const routes = instructions.split('## Decide the current turn')[1].split('## Grounding and broader answers')[0];
  assert.deepEqual([...routes.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1])), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(instructions.includes('`<!-- Preview ID: UUID -->`'));
  assert.equal(instructions.split('`\\n\\n<!-- Preview ID: ACTUAL_UUID -->`').length - 1, 2);
});

test('published routing clarifies missing intent or save content before broadening or searching', async () => {
  await publishStoredTreeDescriptions();
  const instructions = globalThis.__publishedTreeInstructions;
  const routes = instructions.split('## Decide the current turn')[1].split('## Grounding and broader answers')[0];
  const clarification = routes.match(/^7\. .+$/m)?.[0];
  assert.ok(clarification);
  assert.match(clarification, /current message and applicable conversation context/);
  assert.match(clarification, /ask one concise clarification question/);
  assert.match(clarification, /Do not invent missing information, call tools merely to guess.*or ask permission to broaden/);
  assert.match(clarification, /"save this in tree" without factual text, an authorized upload.*paste the text or attach the file/);
  assert.match(clarification, /Do not ask for content again when an earlier eligible route already identifies it/);
  assert.match(clarification, /clear question with an unknown answer needs search/);
  assert.match(routes, /^8\. If the current message explicitly requests broader knowledge/m);
  assert.match(routes, /^9\. Otherwise start grounded/m);
  const outcome = instructions.match(/^- Clarification of an unclear request.+$/m)?.[0];
  assert.ok(outcome);
  assert.match(outcome, /knowledgeMode="grounded", isPermissionToBroadenRequest=false, isPersistenceOffer=false, persistenceAction="none", isWaitingForContinuation=false/);
  assert.match(outcome, /not a factual answer requiring search_tree_\* evidence/);
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
