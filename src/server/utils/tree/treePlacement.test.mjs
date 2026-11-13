import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const exportsByModule = {
  blobStorage: ['deleteNodeAttachmentBlobIfExists', 'restoreNodeAttachmentBlobIfDeleted', 'uploadNodeAttachment'],
  foundryAgentClient: ['getProjectClient', 'getRequiredFoundryConfig'],
  treeGenerationService: ['generateChatLeafPathPlan', 'generateChildTitlesFromBreadcrumb', 'generateMergedLeafNotes', 'generateLeafNotesDraft', 'selectChatPlacementCandidates'],
  azureSearch: ['requestTreeSqlIndexerRun'],
  logging: ['logException', 'logTrace'],
  secretFunctionClient: ['invokeSecretFunction'],
  sql: ['getRequiredApplicationIdentifier', 'sql', 'withSqlConnection'],
  personalCacheTreeRepository: ['permanentlyDeletePersonalCacheNode'],
  treePathRepository: ['assertConfiguredTree', 'listActiveTreeSubtreeAttachments', 'softDeleteTreeSubtree'],
  treeRecordRepository: [
    'applyAttachmentReviewStatus', 'applyTreeNodeReviewStatus', 'assertLeafNode', 'createAttachmentMetadataRecord',
    'createTreeNodeRecord', 'ensureTreeNodeDetailsRow', 'getDescendantSecretMetadata', 'getNodeDetails',
    'getNodeGenerationContext', 'getTreeMaxDepth', 'queryAttachmentDeleteRecord',
    'queryAttachmentRecord', 'queryNodeDetails', 'queryTreeData', 'queryTreeNode', 'queryTreeNodeDetailRecord',
    'queryTreeSummary', 'softDeleteAttachmentMetadataRecord', 'updateUnchangedLeafNotes', 'updateTreeNodeText',
    'upsertTreeNodeDetails',
  ],
  treeCatalog: ['assertTreeAccess', 'getAuditMetadata', 'isPersonalCacheTree'],
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const name = specifier.split('/').at(-1);
    const exports = exportsByModule[name];
    if (specifier.startsWith('@/') && exports) {
      const code = exports.map((key) => key === 'sql'
        ? 'export const sql = new Proxy({}, { get: (_, property) => globalThis.__placementMocks.sql[property] });'
        : `export const ${key} = (...args) => globalThis.__placementMocks.${key}(...args);`).join('\n');
      return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}.js`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { createLeafNodeFromChat, previewLeafFromChat, updateTreeNodeDetails } = await import('./treeMutationService.js');
const { generateChatLeafPathPlan, generateMergedLeafNotes, selectChatPlacementCandidates } = await import('./treeGenerationService.js');
const { copyPublicTreeRecords, updateUnchangedLeafNotes } = await import('./treeRecordRepository.js');

function prepare(nodes, choose) {
  const calls = [];
  const pathPlans = [];
  const detailsRead = [];
  let generated = 0;
  globalThis.__placementMocks = {
    queryTreeData: async () => nodes,
    queryTreeSummary: async () => ({ treeName: 'Knowledge' }),
    getTreeMaxDepth: async () => 3,
    queryTreeNodeDetailRecord: async (_, id) => {
      detailsRead.push(String(id));
      return { notes: `Original ${id}`, isSecret: false };
    },
    selectChatPlacementCandidates: async (request) => {
      calls.push(request);
      return choose(request);
    },
    generateChatLeafPathPlan: async (request) => {
      pathPlans.push(request);
      generated += 1;
      return { pathTitles: Array.from({ length: request.requiredPathTitleCount }, (_, index) => `New category ${index}`), generatedLeafTitle: 'New note' };
    },
  };
  return { calls, pathPlans, detailsRead, get generated() { return generated; } };
}

function node(id, parent, depth, isLeafNode = false) {
  return { id: String(id), parent: parent === null ? null : String(parent), _depth: depth, name: `Topic ${id}`, isLeafNode };
}

test('new attachment leaf rolls back node and metadata and deletes its blob on failure', async () => {
  const calls = [];
  globalThis.__placementMocks = {
    withSqlConnection: async (action) => action(),
    sql: { Transaction: class {
      async begin() { calls.push('begin'); }
      async commit() { calls.push('commit'); }
      async rollback() { calls.push('rollback'); }
    } },
    queryTreeSummary: async () => ({ treeName: 'Knowledge' }),
    queryTreeData: async () => [],
    createTreeNodeRecord: async () => ({ createdNodeId: '4', isLeafNode: true }),
    queryTreeNode: async () => ({ isLeafNode: true }),
    updateTreeNodeText: async () => 1,
    upsertTreeNodeDetails: async () => {},
    getAuditMetadata: () => ({ updatedByObjectId: 'owner' }),
    uploadNodeAttachment: async () => { calls.push('upload'); return { blobName: 'permanent-blob', contentType: 'image/png', byteSize: 4 }; },
    createAttachmentMetadataRecord: async () => { calls.push('metadata'); throw new Error('metadata unavailable'); },
    deleteNodeAttachmentBlobIfExists: async () => { calls.push('delete'); },
  };
  const file = { name: 'photo.png', type: 'image/png', size: 4, arrayBuffer: async () => Buffer.from('file') };
  await assert.rejects(createLeafNodeFromChat({
    treeInstanceId: 7, principal: {}, toolName: 'confirm_save_to_tree', originalQuestion: 'photo',
    broaderAnswer: 'Image caption:\nA harbor.', placementMode: 'full_path_from_root',
    generatedLeafTitle: 'Photo', generatedPathTitles: [], attachmentFile: file,
  }), /metadata unavailable/);
  assert.deepEqual(calls, ['begin', 'upload', 'metadata', 'rollback', 'delete']);
});

test('model merge may rewrite the existing note', async () => {
  globalThis.__placementMocks = {
    getProjectClient: () => ({ getOpenAIClient: () => ({ responses: { create: async () => ({ output_text: JSON.stringify({ notes: 'Rewritten original and new fact' }) }) } }) }),
    getRequiredFoundryConfig: () => ({ modelDeploymentName: 'test' }),
  };

  const notes = await generateMergedLeafNotes({ treeName: 'Knowledge', breadcrumb: 'Topic', originalNotes: 'Original note.', broaderAnswer: 'New fact.' });
  assert.equal(notes, 'Rewritten original and new fact');
});

test('valid model merge retains its placement of new content', async () => {
  globalThis.__placementMocks = {
    getProjectClient: () => ({ getOpenAIClient: () => ({ responses: { create: async () => ({ output_text: JSON.stringify({ notes: 'New fact. Original note.' }) }) } }) }),
    getRequiredFoundryConfig: () => ({ modelDeploymentName: 'test' }),
  };

  const notes = await generateMergedLeafNotes({ treeName: 'Knowledge', breadcrumb: 'Topic', originalNotes: 'Original note.', broaderAnswer: 'New fact.' });
  assert.equal(notes, 'New fact. Original note.');
});

test('model merge rejects content that exceeds the note limit', async () => {
  globalThis.__placementMocks = {
    getProjectClient: () => ({ getOpenAIClient: () => ({ responses: { create: async () => ({ output_text: JSON.stringify({ notes: 'x'.repeat(4001) }) }) } }) }),
    getRequiredFoundryConfig: () => ({ modelDeploymentName: 'test' }),
  };

  await assert.rejects(generateMergedLeafNotes({ treeName: 'Knowledge', breadcrumb: 'Topic', originalNotes: 'Original note.', broaderAnswer: 'New fact.' }), /exceeds the allowed length/);
});

test('upload merge requires the exact labeled incoming block once', async () => {
  let generated = 'Original note. User description:\nA trout.';
  const incomingNotes = 'User description:\nA trout.';
  globalThis.__placementMocks = {
    getProjectClient: () => ({ getOpenAIClient: () => ({ responses: { create: async () => ({ output_text: JSON.stringify({ notes: generated }) }) } }) }),
    getRequiredFoundryConfig: () => ({ modelDeploymentName: 'test' }),
  };
  const options = { treeName: 'Knowledge', breadcrumb: 'Topic', originalNotes: 'Original note.', broaderAnswer: incomingNotes, incomingNotes };
  assert.equal(await generateMergedLeafNotes(options), generated);
  generated = 'Original note. A trout.';
  await assert.rejects(generateMergedLeafNotes(options), /preserve the labeled upload text/);
  generated = `${incomingNotes}\n${incomingNotes}`;
  await assert.rejects(generateMergedLeafNotes(options), /preserve the labeled upload text/);
});

test('every descendant title is considered in bounded batches; only shortlisted notes are read', async () => {
  const nodes = [node(1, null, 0), node(2, 1, 1), node(3, 1, 1)];
  for (let index = 0; index < 380; index += 1) nodes.push(node(100 + index, index % 2 ? 2 : 3, 3, true));
  const targetId = '479';
  const modelCalls = [];
  const observed = prepare(nodes, ({ stage, candidates }) => {
    if (stage === 'root') return ['1'];
    if (stage === 'shortlist') return candidates.some((candidate) => candidate.nodeId === targetId) ? [targetId] : [];
    if (stage === 'rank') return [candidates[0].nodeId];
    return [];
  });
  const selectCandidates = globalThis.__placementMocks.selectChatPlacementCandidates;
  globalThis.__placementMocks.selectChatPlacementCandidates = async (request) => {
    request.onModelCall?.({ stage: request.stage, candidateCount: request.candidates.length });
    return selectCandidates(request);
  };

  const preview = await previewLeafFromChat({ treeInstanceId: 7, originalQuestion: 'Question', broaderAnswer: 'Answer', onModelCall: (call) => modelCalls.push(call) });
  assert.equal(preview.mergeTarget.nodeId, targetId);
  assert.equal(preview.defaultSaveMode, 'merge_existing');
  assert.equal(observed.generated, 0);
  assert.deepEqual(observed.detailsRead, [targetId]);
  const titleCalls = observed.calls.filter((call) => call.stage === 'shortlist');
  assert.ok(titleCalls.length > 10);
  assert.ok(titleCalls.every((call) => call.candidates.length <= 30 && call.candidates.every((candidate) => !candidate.notes)));
  assert.equal(new Set(titleCalls.flatMap((call) => call.candidates.map((candidate) => candidate.nodeId))).size, 380);
  assert.deepEqual(modelCalls, observed.calls.map(({ stage, candidates }) => ({ stage, candidateCount: candidates.length })));
});

test('empty shortlist chooses deepest fitting structural node before generating path', async () => {
  const observed = prepare([node(1, null, 0), node(2, 1, 1), node(3, 2, 2), node(4, 3, 3, true)], ({ stage, candidates }) => {
    if (stage === 'root') return ['1'];
    if (stage === 'anchor' && candidates[0].nodeId === '3') return ['3'];
    return [];
  });
  const preview = await previewLeafFromChat({ treeInstanceId: 7, originalQuestion: 'Question', broaderAnswer: 'Answer' });
  assert.equal(preview.selectedAnchorNodeId, '3');
  assert.equal(preview.placementMode, 'direct_leaf_from_anchor');
  assert.equal(observed.generated, 1);
  assert.deepEqual(observed.detailsRead, []);
});

test('volume of a triangular prism stays under the fitting volume branch', async () => {
  const nodes = [
    { ...node(1, null, 0), name: 'Geometri' },
    { ...node(2, 1, 1), name: 'Plane figurer' },
    { ...node(3, 1, 1), name: 'Rumfang' },
    { ...node(4, 2, 2), name: 'Typer af plane figurer' },
    { ...node(5, 3, 2), name: 'Rumfang af geometriske figurer' },
    { ...node(6, 4, 3, true), name: 'Trekanter' },
    { ...node(7, 5, 3, true), name: 'Rumfang af kugle' },
  ];
  const observed = prepare(nodes, ({ stage, candidates }) => {
    if (stage === 'root') return ['1'];
    if (stage === 'structural') return candidates.some((candidate) => candidate.nodeId === '3') ? ['3'] : ['5'];
    if (stage === 'shortlist') return candidates.some((candidate) => candidate.nodeId === '6') ? ['6'] : [];
    if (stage === 'rank') return [candidates[0].nodeId];
    return [];
  });

  const preview = await previewLeafFromChat({ treeInstanceId: 7, originalQuestion: 'Rumfang af prismeformet trekant', broaderAnswer: 'Find rumfanget af et trekantet prisme.' });
  assert.equal(preview.selectedAnchorNodeId, '5');
  assert.equal(preview.placementMode, 'direct_leaf_from_anchor');
  assert.equal(preview.mergeTarget, null);
  assert.deepEqual(observed.calls.map(({ stage }) => stage), ['root', 'structural', 'structural', 'leaf']);
  assert.ok(observed.calls.every(({ stage, parentBreadcrumb, candidates }) => stage === 'root' || parentBreadcrumb === 'Geometri' || candidates.every((candidate) => candidate.nodeId !== '2' && candidate.nodeId !== '4' && candidate.nodeId !== '6')));
  assert.deepEqual(observed.detailsRead, []);
});

test('a leaf level with no children does not run leaf selection', async () => {
  const observed = prepare([node(1, null, 0), node(2, 1, 1), node(3, 2, 2)], ({ stage, candidates }) => {
    if (stage === 'root') return ['1'];
    if (stage === 'structural') return [candidates[0].nodeId];
    return [];
  });

  const preview = await previewLeafFromChat({ treeInstanceId: 7, originalQuestion: 'Question', broaderAnswer: 'Answer' });
  assert.equal(preview.selectedAnchorNodeId, '3');
  assert.deepEqual(observed.calls.map(({ stage }) => stage), ['root', 'structural', 'structural']);
});

test('bottom-up anchor search stays beneath the selected structural node', async () => {
  const nodes = [
    node(1, null, 0), node(2, 1, 1), node(3, 2, 2), node(4, 3, 3, true),
    node(5, 1, 1), node(6, 5, 2), node(7, 6, 3, true),
  ];
  const observed = prepare(nodes, ({ stage, candidates, parentBreadcrumb }) => {
    if (stage === 'root') return ['1'];
    if (stage === 'structural' && parentBreadcrumb === 'Topic 1') return ['2'];
    if (stage === 'anchor') return ['3'];
    return [];
  });

  const preview = await previewLeafFromChat({ treeInstanceId: 7, originalQuestion: 'Question', broaderAnswer: 'Answer' });
  assert.equal(preview.selectedAnchorNodeId, '3');
  assert.equal(preview.placementMode, 'direct_leaf_from_anchor');
  assert.deepEqual(observed.calls.filter(({ stage }) => stage === 'anchor').map(({ candidates }) => candidates.map((candidate) => candidate.nodeId)), [['3']]);
  assert.ok(observed.calls.filter(({ stage }) => stage === 'shortlist').every(({ candidates }) => candidates.every((candidate) => candidate.nodeId !== '7')));
});

test('no fitting root generates a new full path without reading leaf notes', async () => {
  const observed = prepare([node(1, null, 0), node(2, 1, 3, true)], () => []);
  const preview = await previewLeafFromChat({ treeInstanceId: 7, originalQuestion: 'Question', broaderAnswer: 'Answer' });
  assert.equal(preview.placementMode, 'full_path_from_root');
  assert.equal(preview.generatedPathTitles.length, 3);
  assert.deepEqual(observed.detailsRead, []);
});

test('one fitting root limits leaf matching to its subtree', async () => {
  const nodes = [node(1, null, 0), node(2, null, 0), node(3, 1, 1), node(4, 2, 1), node(5, 3, 3, true), node(6, 4, 3, true)];
  const observed = prepare(nodes, ({ stage, candidates }) => {
    if (stage === 'root') return ['2'];
    if (stage === 'structural') return candidates.some((candidate) => candidate.nodeId === '4') ? ['4'] : [];
    if (stage === 'shortlist') return candidates.map((candidate) => candidate.nodeId);
    if (stage === 'rank') return [candidates.at(-1).nodeId];
    return [];
  });
  globalThis.__placementMocks.queryTreeNodeDetailRecord = async (_, id) => {
    observed.detailsRead.push(String(id));
    return { notes: `Unrelated existing subtopic ${id}`, isSecret: false };
  };
  const preview = await previewLeafFromChat({ treeInstanceId: 7, originalQuestion: 'New topic', broaderAnswer: 'New content' });
  assert.equal(preview.mergeTarget.nodeId, '6');
  assert.equal(observed.generated, 0);
  assert.deepEqual(observed.detailsRead, ['6']);
  assert.equal(observed.calls.filter((call) => call.stage === 'rank').length, 1);
  assert.ok(observed.calls.every(({ stage, candidates }) => stage === 'root' || candidates.every((candidate) => candidate.nodeId !== '3' && candidate.nodeId !== '5')));
});

test('empty notes and secret status do not prevent matching a fitting leaf', async () => {
  const observed = prepare([node(1, null, 0), node(2, 1, 1), node(3, 2, 3, true)], ({ stage, candidates }) => {
    if (stage === 'root') return ['1'];
    if (stage === 'structural') return candidates.some((candidate) => candidate.nodeId === '2') ? ['2'] : [];
    if (stage === 'shortlist') return ['3'];
    if (stage === 'rank') return [candidates[0].nodeId];
    return [];
  });
  globalThis.__placementMocks.queryTreeNodeDetailRecord = async (_, id) => {
    observed.detailsRead.push(String(id));
    return { notes: '', isSecret: true };
  };
  const preview = await previewLeafFromChat({ treeInstanceId: 7, originalQuestion: 'Question', broaderAnswer: 'Answer' });
  assert.equal(preview.mergeTarget.nodeId, '3');
  assert.equal(observed.calls.filter((call) => call.stage === 'rank').length, 1);
});

test('merge SQL updates notes without reading or writing secret fields', async () => {
  let updateQuery = '';
  class Request {
    input() { return this; }
    async query(query) {
      updateQuery = query;
      return { rowsAffected: [1] };
    }
  }
  globalThis.__placementMocks = { sql: { Request, Int: 'Int', NVarChar: Object.assign(() => 'NVarChar', { MAX: 'MAX' }) } };
  const updated = await updateUnchangedLeafNotes({
    treeInstanceId: 7, nodeId: '3', originalNotes: 'Original', notes: 'Merged',
    expectedTitle: 'Topic 3', expectedParentId: '2', updatedBy: null,
  });
  assert.equal(updated, true);
  assert.match(updateQuery, /notes = @notes/);
  assert.match(updateQuery, /details\.notes\) = CONVERT\(VARBINARY\(MAX\), @original_notes\)/);
  assert.doesNotMatch(updateQuery, /is_secret|secret_metadata/);
});

test('details edit without isSecret preserves the stored secret without contacting the broker', async () => {
  const savedDetails = [];
  globalThis.__placementMocks = {
    withSqlConnection: async (operation) => operation(),
    queryTreeNode: async () => ({ isLeafNode: true }),
    updateTreeNodeText: async () => 1,
    queryTreeNodeDetailRecord: async () => ({ isSecret: true, secretMetadata: JSON.stringify({ secretName: 'existing' }) }),
    upsertTreeNodeDetails: async (details) => savedDetails.push(details),
    queryTreeData: async () => [],
    queryNodeDetails: async () => ({}),
    invokeSecretFunction: async () => { throw new Error('Secret broker must not be called'); },
  };

  await updateTreeNodeDetails(7, 3, { name: 'Leaf', notes: 'Updated notes' });
  assert.equal(savedDetails.length, 1);
  assert.equal(savedDetails[0].isSecret, true);
  assert.deepEqual(JSON.parse(savedDetails[0].secretMetadata), { provider: 'azure_key_vault', secretName: 'existing', version: null, vaultUrl: null, displayLabel: 'existing' });
});

test('details edit with explicit isSecret false deletes the stored secret', async () => {
  const brokerActions = [];
  const savedDetails = [];
  globalThis.__placementMocks = {
    withSqlConnection: async (operation) => operation(),
    queryTreeNode: async () => ({ isLeafNode: true }),
    updateTreeNodeText: async () => 1,
    queryTreeNodeDetailRecord: async () => ({ isSecret: true, secretMetadata: JSON.stringify({ secretName: 'existing' }) }),
    upsertTreeNodeDetails: async (details) => savedDetails.push(details),
    queryTreeData: async () => [],
    queryNodeDetails: async () => ({}),
    invokeSecretFunction: async ({ action }) => brokerActions.push(action),
  };

  await updateTreeNodeDetails(7, 3, { name: 'Leaf', notes: 'Updated notes', isSecret: false });
  assert.deepEqual(brokerActions, ['delete-secret']);
  assert.equal(savedDetails[0].isSecret, false);
  assert.equal(savedDetails[0].secretMetadata, null);
});

test('public tree copy keeps ordinary notes and attachments but not secret metadata', async () => {
  const queries = [];
  const copiedFiles = [];
  class Request {
    inputs = {};
    input(name, _, value) {
      this.inputs[name] = value;
      return this;
    }
    async query(query) {
      queries.push({ query, inputs: this.inputs });
      if (query.includes('SELECT TOP 1 ti.application_instance_id')) {
        return { recordset: [{ applicationInstanceId: 1, name: 'Public', description: '' }] };
      }
      if (query.includes('WITH active_nodes AS')) {
        return { recordset: [{ id: 9, parentId: null, text: 'Leaf', isLeafNode: true, isExpanded: true, draggable: true, sortOrder: 0 }] };
      }
      if (query.includes('SELECT details.tree_node_id AS nodeId')) {
        return { recordset: [{ nodeId: 9, notes: 'Ordinary notes', isSecret: true }] };
      }
      if (query.includes('SELECT files.tree_node_id AS nodeId')) {
        return { recordset: [{ nodeId: 9, fileName: 'notes.txt', blobName: 'source-blob' }] };
      }
      if (query.includes('OUTPUT INSERTED.id AS id')) return { recordset: [{ id: 70 }] };
      if (query.includes('SELECT id FROM @createdNodes')) return { recordset: [{ id: 101 }] };
      return { rowsAffected: [1] };
    }
  }
  globalThis.__placementMocks = {
    getRequiredApplicationIdentifier: () => 'app',
    sql: { Request, Int: 'Int', Bit: 'Bit', BigInt: 'BigInt', NVarChar: Object.assign(() => 'NVarChar', { MAX: 'MAX' }) },
  };
  const copiedTreeId = await copyPublicTreeRecords({
    sourceTreeId: 7, owner: { treeKey: 'copy', ownerObjectId: 'owner' }, transaction: {},
    copyAttachment: async ({ file }) => {
      copiedFiles.push(file.blobName);
      return { originalFileName: file.fileName, blobName: 'copied-blob', blobUrl: 'copied-url', contentType: 'text/plain', byteSize: 10 };
    },
  });
  assert.equal(copiedTreeId, 70);
  assert.deepEqual(copiedFiles, ['source-blob']);
  const filesQuery = queries.find(({ query }) => query.includes('SELECT files.tree_node_id AS nodeId')).query;
  assert.doesNotMatch(filesQuery, /is_secret/);
  const detailsUpdate = queries.find(({ query }) => query.includes('UPDATE tree_node_details SET notes = @notes'));
  assert.equal(detailsUpdate.inputs.notes, 'Ordinary notes');
  assert.match(detailsUpdate.query, /is_secret = 0, secret_metadata = NULL/);
  assert.match(detailsUpdate.query, /VALUES \(@tree_node_id, @notes, 0, NULL\)/);
});

test('model-selected IDs must belong to the offered candidates', async () => {
  const responses = ['{"selectedNodeIds":["secret"]}', '{"selectedNodeIds":["allowed"]}'];
  const modelCalls = [];
  globalThis.__placementMocks = {
    getRequiredFoundryConfig: () => ({ modelDeploymentName: 'mock-model' }),
    getProjectClient: () => ({ getOpenAIClient: () => ({ responses: {
      create: async () => ({ output_text: responses.shift() }),
    } }) }),
  };
  const selected = await selectChatPlacementCandidates({
    treeName: 'Knowledge', originalQuestion: 'Question', broaderAnswer: 'Answer',
    candidates: [{ nodeId: 'allowed', breadcrumb: 'Root > Allowed' }], stage: 'rank', required: true,
    onModelCall: (call) => modelCalls.push(call),
  });
  assert.deepEqual(selected, ['allowed']);
  assert.equal(responses.length, 0);
  assert.deepEqual(modelCalls, [
    { stage: 'rank', candidateCount: 1, selectedNodeIds: ['secret'], validation: 'rejected', error: 'Placement selection contained invalid candidate IDs.' },
    { stage: 'rank', candidateCount: 1, selectedNodeIds: ['allowed'], validation: 'accepted' },
  ]);
});

test('malformed placement responses are reported in the call trace before retry', async () => {
  const responses = ['not JSON', '{"selectedNodeIds":[]}'];
  const modelCalls = [];
  globalThis.__placementMocks = {
    getRequiredFoundryConfig: () => ({ modelDeploymentName: 'mock-model' }),
    getProjectClient: () => ({ getOpenAIClient: () => ({ responses: {
      create: async () => ({ output_text: responses.shift() }),
    } }) }),
  };

  await selectChatPlacementCandidates({
    treeName: 'Knowledge', originalQuestion: 'Question', broaderAnswer: 'Answer',
    candidates: [{ nodeId: 'allowed', breadcrumb: 'Root > Allowed' }], stage: 'shortlist',
    onModelCall: (call) => modelCalls.push(call),
  });
  assert.deepEqual(modelCalls, [
    { stage: 'shortlist', candidateCount: 1, selectedNodeIds: null, validation: 'rejected', error: 'Model response was not valid JSON.' },
    { stage: 'shortlist', candidateCount: 1, selectedNodeIds: [], validation: 'accepted' },
  ]);
});

test('completed upload caption reaches placement selection and new path planning without entering saved content', async () => {
  const observed = prepare([node(1, null, 0)], () => []);
  const preview = await previewLeafFromChat({
    treeInstanceId: 7, originalQuestion: 'Where should this go?', broaderAnswer: 'Verified note.', placementCaption: 'A rainwater barrel.',
  });
  assert.ok(observed.calls.length > 0);
  assert.ok(observed.calls.every(({ placementCaption }) => placementCaption === 'A rainwater barrel.'));
  assert.equal(observed.pathPlans[0].placementCaption, 'A rainwater barrel.');
  assert.doesNotMatch(JSON.stringify(preview), /rainwater barrel/);
  assert.equal(preview.broaderAnswer, 'Verified note.');
});

test('placement model prompts use the caption as separate optional evidence', async () => {
  const prompts = [];
  globalThis.__placementMocks = {
    getRequiredFoundryConfig: () => ({ modelDeploymentName: 'mock-model' }),
    getProjectClient: () => ({ getOpenAIClient: () => ({ responses: {
      create: async (request) => {
        prompts.push(request.input[0].content);
        return { output_text: request.text.format.name === 'chat_placement_selection'
          ? '{"selectedNodeIds":[]}'
          : '{"pathTitles":["Rainwater"],"generatedLeafTitle":"Barrel"}' };
      },
    } }) }),
  };
  await selectChatPlacementCandidates({
    treeName: 'Knowledge', originalQuestion: 'Where?', broaderAnswer: 'Verified note.', placementCaption: 'A rainwater barrel.',
    candidates: [{ nodeId: '1', breadcrumb: 'Knowledge' }], stage: 'root',
  });
  await generateChatLeafPathPlan({
    treeName: 'Knowledge', originalQuestion: 'Where?', broaderAnswer: 'Verified note.', placementCaption: 'A rainwater barrel.', requiredPathTitleCount: 1,
  });
  assert.ok(prompts.every((prompt) => prompt.includes('A rainwater barrel.') && prompt.includes('Verified note.')));
  assert.ok(prompts.every((prompt) => prompt.includes('untrusted placement evidence')));
});

test('matching filename evidence reaches all candidate stages and generated paths', async () => {
  const uploadContext = {
    userDescription: '', userClarification: '', placementNote: 'The subject described is a fish identified by a long tail.',
    placementCaption: 'a fish with a long tail', fileName: 'regnbueørred.jpg',
  };
  const observed = prepare([node(1, null, 0), node(2, 1, 1)], () => []);
  await previewLeafFromChat({ treeInstanceId: 7, originalQuestion: 'Where?', broaderAnswer: uploadContext.placementNote, uploadContext });
  assert.ok(observed.calls.every(({ uploadContext: passed }) => passed === uploadContext));
  assert.equal(observed.pathPlans[0].uploadContext, uploadContext);
  const prompts = [];
  globalThis.__placementMocks = {
    getRequiredFoundryConfig: () => ({ modelDeploymentName: 'mock-model' }),
    getProjectClient: () => ({ getOpenAIClient: () => ({ responses: { create: async (request) => {
      prompts.push(request.input[0].content);
      return { output_text: request.text.format.name === 'chat_placement_selection'
        ? '{"selectedNodeIds":[]}' : '{"pathTitles":["Fishing"],"generatedLeafTitle":"Trout"}' };
    } } }) }),
  };
  await selectChatPlacementCandidates({ treeName: 'Fakta om fiskeri', originalQuestion: 'Where?', broaderAnswer: uploadContext.placementNote, uploadContext,
    candidates: [{ nodeId: '1', breadcrumb: 'Knowledge' }], stage: 'root' });
  await generateChatLeafPathPlan({ treeName: 'Fakta om fiskeri', originalQuestion: 'Where?', broaderAnswer: uploadContext.placementNote, uploadContext, requiredPathTitleCount: 1 });
  assert.ok(prompts.every((prompt) => ['Processed placement note: The subject described is a fish identified by a long tail.',
    'Filtered image caption (generated): a fish with a long tail',
    'Original filename (placement evidence when topic matches): regnbueørred.jpg'].every((field) => prompt.includes(field))));
  assert.ok(prompts.every((prompt) => prompt.includes('choose the most specific fitting branch or leaf')));
  assert.ok(prompts.some((prompt) => prompt.includes('the labeled upload placement evidence below')));
  assert.ok(prompts.every((prompt) => !prompt.includes('subject of the answer')));
  assert.ok(prompts.every((prompt) => !prompt.includes('prefer the note if they conflict')));
});