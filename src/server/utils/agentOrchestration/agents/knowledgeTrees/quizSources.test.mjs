import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/shared/interactions') {
      return nextResolve(new URL('../../../../../shared/interactions.js', import.meta.url).href, context);
    }
    let source;
    if (specifier === '@/server/utils/sql') {
      source = `
        export const getRequiredApplicationIdentifier = () => 'quiz-app';
        export const withSqlConnection = async (callback) => {
          globalThis.__quizConnected = true;
          try { return await callback(); } finally { globalThis.__quizConnected = false; }
        };
        export const sql = {
          Int: 'int', NVarChar: 'nvarchar',
          Request: class {
            constructor() {
              if (!globalThis.__quizConnected) throw new Error('Request outside connection');
              this.inputs = {};
            }
            input(name, type, value) { this.inputs[name] = value; return this; }
            query(text) { return globalThis.__quizQuery(text, this.inputs); }
          },
        };
      `;
    }
    if (specifier === '@/server/utils/tree/treeCatalog') {
      source = 'export const assertTreeAccess = (...args) => globalThis.__quizAccess(...args);';
    }
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const {
  assertQuizSourceAccess, listQuizTrees, listQuizRoots, prepareQuizSources,
} = await import('./quizSources.js');

let nodes;
let details;
let queries;
let accesses;
let metadata;
const principal = { user: 'alice', app: 'quiz-app' };
const options = (extra = {}) => ({
  principal, visibility: 'private', includedTrees: [{ id: '1', name: 'Topics' }],
  treeId: '1', rootIds: ['10'], ...extra,
});
const root = (id = 10, title = 'Topic', sortOrder = 0) => ({
  id, parentId: null, title, sortOrder, isLeafNode: false,
});
const leaf = (id = 11, parentId = 10, title = `Leaf ${id}`, sortOrder = id) => ({
  id, parentId, title, sortOrder, isLeafNode: true,
});
function setup(count = 1, notes = 'Ordinary notes') {
  queries = [];
  accesses = [];
  metadata = new Map([['1', '2026-01-01T00:00:00.000Z']]);
  nodes = [root(), ...Array.from({ length: count }, (_, index) => leaf(11 + index))];
  details = new Map(nodes.filter((node) => node.isLeafNode).map(({ id }) => [String(id), {
    id, notes, isSecret: false, hasAttachments: false, revision: '2026-01-02T00:00:00.000Z',
  }]));
  globalThis.__quizAccess = async (id, scope) => { accesses.push({ id, ...scope }); return { id }; };
  globalThis.__quizQuery = async (text, inputs) => {
    queries.push({ text, inputs });
    assert.equal(inputs.application_identifier, 'quiz-app');
    assert.equal(inputs.tree_instance_id, 1, 'data must remain in the selected tree');
    if (text.includes('SELECT ti.updated_at')) {
      return { recordset: metadata.has(String(inputs.tree_instance_id))
        ? [{ updatedAt: metadata.get(String(inputs.tree_instance_id)) }] : [] };
    }
    if (text.includes('LEFT JOIN tree_node_details')) {
      assert.match(text, /FROM tree_node_detail_files files/);
      assert.match(text, /CASE WHEN COALESCE\(tnd.is_secret, 0\) = 0 AND tnd.secret_metadata IS NULL\s+THEN tnd.notes ELSE NULL END/);
      assert.doesNotMatch(text, /secret_metadata\s+AS|blob_url|blob_name|original_file_name/);
      const ids = Object.entries(inputs).filter(([key]) => key.startsWith('leaf_')).map(([, id]) => String(id));
      return { recordset: ids.flatMap((id) => {
        const detail = details.get(id);
        return detail ? [{ ...detail, notes: detail.isSecret ? null : detail.notes }] : [];
      }) };
    }
    assert.match(text, /tn.deleted_at IS NULL/);
    assert.match(text, /ti.deleted_at IS NULL/);
    return { recordset: text.includes('AND tn.parent_id IS NULL')
      ? nodes.filter((node) => node.parentId === null) : [...nodes] };
  };
}

test('only catalog trees appear, latest TREE metadata wins, and cap and ID tie-break are explicit', async () => {
  setup();
  const includedTrees = Array.from({ length: 22 }, (_, index) => ({
    id: String(index + 1), name: `Tree ${index + 1}`,
    updatedAt: index < 2 ? '2026-01-01' : '2026-02-01',
  }));
  includedTrees.push({ ...includedTrees[21] });
  const result = await listQuizTrees(options({ includedTrees }));
  assert.equal(result.total, 22);
  assert.equal(result.limitedToRecent, true);
  assert.equal(result.trees.length, 20);
  assert.deepEqual(result.trees.map(({ id }) => id), Array.from({ length: 20 }, (_, i) => String(22 - i)));
  assert.deepEqual(result.trees[0], {
    id: '22', optionId: 'tree-22', label: 'Tree 22', updatedAt: '2026-02-01T00:00:00.000Z',
  });
  assert.equal(queries.length, 0);
  assert.equal(accesses.length, 22);
  assert.ok(accesses.every((scope) => scope.principal === principal && scope.visibility === 'private'));
  assert.deepEqual(await listQuizTrees(options({ includedTrees: [] })), {
    trees: [], total: 0, limitedToRecent: false,
  });
});

test('missing catalog timestamps are read from authorized application-scoped tree_instance.updated_at', async () => {
  setup();
  const result = await listQuizTrees(options());
  assert.deepEqual(result, { trees: [{
    id: '1', optionId: 'tree-1', label: 'Topics', updatedAt: '2026-01-01T00:00:00.000Z',
  }], total: 1, limitedToRecent: false });
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /ti.updated_at AS updatedAt/);
  assert.equal(accesses[0].id, '1');
  metadata.clear();
  await assert.rejects(listQuizTrees(options()), { status: 409 });
});

test('roots are actual parentless nodes, including leaves, ordered by sibling position and numeric ID', async () => {
  setup();
  nodes = [root(20, 'Second', 1), leaf(12, null, 'Top-level leaf', 0), root(10, 'First', 0), leaf()];
  const result = await listQuizRoots(options({ treeId: '001' }));
  assert.deepEqual(result, {
    treeId: '1', roots: [
      { id: '10', optionId: 'root-10', label: 'First' },
      { id: '12', optionId: 'root-12', label: 'Top-level leaf' },
      { id: '20', optionId: 'root-20', label: 'Second' },
    ], total: 3, matching: 3, requiresNarrowing: false,
  });
  assert.deepEqual(accesses, [{ id: '1', principal, visibility: 'private' }]);
});

test('root substring filtering reports exact counts and never silently truncates above twenty', async () => {
  setup();
  nodes = Array.from({ length: 21 }, (_, index) => root(index + 10, index ? `Topic ${index}` : 'Needle TOPIC'));
  assert.deepEqual(await listQuizRoots(options()), {
    treeId: '1', roots: [], total: 21, matching: 21, requiresNarrowing: true,
  });
  const filtered = await listQuizRoots(options({ filter: 'nEeDlE' }));
  assert.equal(filtered.total, 21);
  assert.equal(filtered.matching, 1);
  assert.equal(filtered.roots[0].id, '10');
  const twenty = await listQuizRoots(options({ filter: 'Topic ' }));
  assert.equal(twenty.roots.length, 20);
  assert.equal(twenty.requiresNarrowing, false);
  assert.equal((await listQuizRoots(options({ filter: 'absent' }))).matching, 0);
  await listQuizRoots(options({ filter: 'x'.repeat(200) }));
  for (const filter of ['x'.repeat(201), 2, {}]) {
    await assert.rejects(listQuizRoots(options({ filter })), { status: 400 });
  }
});

test('source snapshot preserves exact notes, traverses full topology, deduplicates roots, and allows top-level leaves', async () => {
  setup();
  const raw = ' \n<h2>Title</h2>\n<p>  exact &amp; text </p>\t';
  nodes = [leaf(31, 30, 'Deep'), root(10, 'Root'), root(30, 'Branch'), leaf(40, null, 'Standalone')];
  nodes.find(({ id }) => id === 30).parentId = 10;
  details = new Map([['31', { id: 31, notes: raw }], ['40', { id: 40, notes: 'Standalone notes' }]]);
  const result = await prepareQuizSources(options({ rootIds: ['040', 10, '10', 40] }));
  assert.equal(result.treeId, '1');
  assert.deepEqual(result.rootIds, ['10', '40']);
  assert.deepEqual(result.leaves, [
    { id: '31', rootId: '10', title: 'Deep', path: 'Root > Branch > Deep', notes: raw, revision: null },
    { id: '40', rootId: '40', title: 'Standalone', path: 'Standalone', notes: 'Standalone notes', revision: null },
  ]);
  assert.deepEqual(result.excludedLeaves, []);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(accesses.length, 2);
});

test('eligible leaf count boundaries accept up to forty-five without sampling and reject zero', async () => {
  for (const count of [0, 25, 26, 45]) {
    setup(count);
    if (count) assert.equal((await prepareQuizSources(options())).leaves.length, count);
    else await assert.rejects(prepareQuizSources(options()), {
      status: 400, message: /no eligible leaves/,
    });
  }
});

test('sixty eligible notes are randomly sampled to forty-five and revalidation reuses the frozen selection', async (t) => {
  setup(63);
  details.get('71').notes = ' ';
  Object.assign(details.get('72'), { notes: '', hasAttachments: true });
  details.get('73').isSecret = true;
  let canSample = true;
  const random = t.mock.method(crypto, 'randomInt', () => {
    assert.ok(canSample, 'A frozen sample must not be redrawn');
    return 0;
  });
  syncBuiltinESMExports();
  t.after(() => { random.mock.restore(); syncBuiltinESMExports(); });
  const first = await prepareQuizSources(options());
  assert.equal(first.leaves.length, 45);
  assert.equal(new Set(first.leaves.map((item) => item.id)).size, 45);
  assert.equal(first.excludedLeaves.filter((item) => item.reason === 'random-sample-limit').length, 15);
  assert.equal(first.excludedLeaves.length, 18);
  assert.equal(first.leaves.some((item) => item.id === '11'), false, 'Sampling is not prefix truncation');
  assert.equal(first.leaves.some((item) => item.id === '56'), true);
  assert.ok(first.leaves.every((item) => !['71', '72', '73'].includes(item.id)));
  canSample = false;
  const frozen = options({ selectedLeafIds: first.leaves.map((item) => item.id) });
  assert.deepEqual(await prepareQuizSources(frozen), first);
  details.get(first.leaves[0].id).notes += ' Changed evidence.';
  assert.notEqual((await prepareQuizSources(frozen)).fingerprint, first.fingerprint);
  details.get(first.leaves[0].id).isSecret = true;
  await assert.rejects(prepareQuizSources(frozen), { status: 409, message: /Selected quiz notes changed/ });
});

test('individual notes use JS length without truncation at 8000/8001, including surrogate pairs', async () => {
  setup(1, '😀'.repeat(4000));
  assert.equal((await prepareQuizSources(options())).leaves[0].notes.length, 8000);
  details.get('11').notes += 'x';
  await assert.rejects(prepareQuizSources(options()), {
    status: 400, message: /Leaf 11 contains 8001 characters.*8000/,
  });
});

test('combined source notes accept exactly 100000 characters and reject 100001', async () => {
  setup(13, 'a'.repeat(8000));
  details.get('23').notes = 'b'.repeat(4000);
  assert.equal((await prepareQuizSources(options())).leaves.reduce((n, item) => n + item.notes.length, 0), 100000);
  details.get('23').notes += 'x';
  await assert.rejects(prepareQuizSources(options()), {
    status: 400, message: /100001 characters.*100000/,
  });
});

test('whitespace, attachment-only and secret-backed leaves are excluded without loading protected material', async () => {
  setup(6);
  details.get('12').notes = ' \n\t';
  Object.assign(details.get('13'), { notes: '', hasAttachments: true });
  Object.assign(details.get('14'), { notes: 'must never be returned', isSecret: true });
  Object.assign(details.get('15'), { notes: 'ordinary with attachment', hasAttachments: true });
  details.get('16').notes = null;
  const result = await prepareQuizSources(options());
  assert.deepEqual(result.leaves.map(({ id }) => id), ['11', '15']);
  assert.deepEqual(result.excludedLeaves, [
    { id: '12', reason: 'empty-notes' }, { id: '13', reason: 'attachment-only' },
    { id: '14', reason: 'secret-backed' }, { id: '16', reason: 'empty-notes' },
  ]);
  assert.ok(!JSON.stringify(result).includes('must never be returned'));
});

test('invalid IDs, missing/nonroot/cross-tree roots and absent selection fail explicitly', async () => {
  setup();
  for (const treeId of ['1x', -1, 0, 1.5, '2147483648', {}, null]) {
    await assert.rejects(assertQuizSourceAccess(options({ treeId })), { status: 400 });
  }
  for (const rootIds of [[], null, ['11'], ['999'], ['10x'], ['0']]) {
    await assert.rejects(prepareQuizSources(options({ rootIds })), { status: 400 });
  }
  assert.equal(details.has('999'), false, 'a node from another tree is not in this topology');
});

test('every API enforces the runtime catalog and current principal/visibility; revoked access stays denied', async () => {
  setup();
  for (const api of [assertQuizSourceAccess, listQuizRoots, prepareQuizSources]) {
    await assert.rejects(api(options({ includedTrees: [{ id: '2' }] })), { status: 403 });
  }
  assert.equal(queries.length, 0);
  assert.equal(accesses.length, 0);
  globalThis.__quizAccess = async (id, scope) => {
    assert.equal(scope.principal, principal);
    assert.equal(scope.visibility, 'private');
    throw new Error('Tree was not found for the active application instance');
  };
  for (const api of [assertQuizSourceAccess, listQuizTrees, listQuizRoots, prepareQuizSources]) {
    await assert.rejects(api(options()), { status: 403 });
  }
  assert.equal(queries.length, 0);
  globalThis.__quizAccess = async () => { throw new Error('SQL unavailable'); };
  await assert.rejects(prepareQuizSources(options()), /SQL unavailable/);
});

test('canonical access return is a string and access is rechecked after preparing source data', async () => {
  setup();
  assert.equal(await assertQuizSourceAccess(options({ treeId: '001' })), '1');
  let calls = 0;
  globalThis.__quizAccess = async () => {
    if (++calls === 2) throw new Error('Tree was not found for the active application instance');
  };
  await assert.rejects(prepareQuizSources(options()), { status: 403 });
});

test('snapshot and fingerprint are deterministic across input/SQL order and sensitive to actual contents and revisions', async () => {
  setup(2);
  nodes.push(leaf(40, null, 'Top leaf'));
  details.set('40', { id: 40, notes: 'Top-level notes', revision: null });
  const first = await prepareQuizSources(options({ rootIds: ['40', '10', '10'] }));
  nodes.reverse();
  const second = await prepareQuizSources(options({ rootIds: ['10', '40'] }));
  assert.deepEqual(second, first);
  for (const mutate of [
    () => { details.get('11').notes += ' '; },
    () => { details.get('11').revision = '2026-01-03'; },
    () => { nodes.find(({ id }) => id === 10).title = 'Renamed root'; },
    () => { details.get('12').isSecret = true; },
  ]) {
    mutate();
    const next = await prepareQuizSources(options({ rootIds: ['10', '40'] }));
    assert.notEqual(next.fingerprint, second.fingerprint);
    second.fingerprint = next.fingerprint;
  }
});

test('a concurrent removed leaf or inconsistent leaf topology fails rather than returning an incomplete snapshot', async () => {
  setup();
  details.clear();
  await assert.rejects(prepareQuizSources(options()), { status: 409, message: /Source leaves changed/ });
  setup();
  nodes.push(leaf(12, 11));
  await assert.rejects(prepareQuizSources(options()), { status: 409, message: /source leaf has children/ });
});
