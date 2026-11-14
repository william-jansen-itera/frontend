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

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = modules.get(specifier);
    return stub
      ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

const { publishStoredTreeDescriptions } = await import('./treeAgentCatalog.js');
const { getRequiredFoundryConfig: getActualFoundryConfig } = await import('../../foundryAgentClient.js');

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

test('published upload policy checks compatible filename hints before asking for identification', async () => {
  await publishStoredTreeDescriptions();
  const section = globalThis.__publishedTreeInstructions.split('#### completed upload')[1].split('### preview_save_to_tree')[0];
  assert.match(section, /Before deciding whether to ask.*normalized filename topic words together/);
  assert.match(section, /Recognize meaningful terms across languages/);
  assert.match(section, /subject independently supported by the note or caption.*preview directly/);
  assert.match(section, /Ask once.*only when the combined evidence still supports merely a generic subject/);
  assert.doesNotMatch(section, /Before previewing.*proactively ask once|gedde/i);
});

test('published upload policy keeps filename hints out of saved facts and preserves human approval', async () => {
  await publishStoredTreeDescriptions();
  const section = globalThis.__publishedTreeInstructions.split('#### completed upload')[1].split('### preview_save_to_tree')[0];
  assert.match(section, /unverified placement hint, not a confirmed identification/);
  assert.match(section, /Do not add filename-only claims to saved notes or put them in userDescription or userClarification/);
  assert.match(section, /Prefer human descriptions and file content when they conflict/);
  assert.match(section, /If neither human context nor the note or caption supports even a general topic, ask the human/);
  assert.match(section, /processing-only, report completion without previewing or asking/);
  assert.match(section, /without asking for details again/);
  assert.match(section, /saving still requires a later human approval of the displayed preview/);
});

test('published confirmation policy copies the latest offered arguments only after human approval', async () => {
  await publishStoredTreeDescriptions();
  const section = globalThis.__publishedTreeInstructions.split('### confirm_save_to_tree')[1].split('## final response format')[0];
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

test('published language policy treats standalone ja as Danish before applying the app-language fallback', async () => {
  await publishStoredTreeDescriptions();
  const section = globalThis.__publishedTreeInstructions.split('## Reply language')[1].split('Tool result meta.')[0];
  assert.match(section, /standalone human reply "ja" \(case-insensitive, allowing surrounding whitespace and trailing punctuation\) as Danish/);
  assert.match(section, /set responseLanguage="da", and cite "ja" as the signal in languageReason instead of using the app-language fallback/);
  assert.match(section, /An explicit language request still takes precedence/);
});
