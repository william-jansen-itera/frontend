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
    export const getRequiredFoundryConfig = () => ({ agentName: 'test-agent', modelDeploymentName: 'test-model' });
    export const getProjectClient = () => ({ agents: {
      update: async (name, definition) => {
        globalThis.__publishedTreeInstructions = definition.instructions;
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
