import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = {
      treeCatalog: 'export const getAuditMetadata = (principal) => ({ updatedByObjectId: principal?.userId });',
      sql: `
        export const getRequiredApplicationIdentifier = () => 'app-a';
        export const withSqlConnection = async (callback) => callback();
        class Request {
          inputs = {};
          input(name, type, value) { this.inputs[name] = value; return this; }
          query(query) { return globalThis.__lookupInteractions({ query, inputs: this.inputs }); }
        }
        export const sql = { Request, Int: 'int', NVarChar: () => 'nvarchar' };`,
    };
    const stub = stubs[specifier.split('/').at(-1)];
    return stub
      ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

const { findLatestActiveInteractionId } = await import('./interactionLookupRepository.js');
const options = { treeId: 7, principal: { userId: 'owner-a' }, workflow: 'interaction-test' };

test('latest lookup is owner/app/workflow scoped, across conversations, with a strict 24-hour cutoff and deterministic newest-first order', async () => {
  let request;
  globalThis.__lookupInteractions = async (value) => {
    request = value;
    return { recordset: [{ interactionId: 'latest-id' }] };
  };
  assert.equal(await findLatestActiveInteractionId(options), 'latest-id');
  assert.deepEqual(request.inputs, {
    tree_id: 7, owner: 'owner-a', application_identifier: 'app-a', workflow: 'interaction-test',
  });
  const { query } = request;
  assert.match(query, /SELECT TOP \(1\) interaction\.text AS interactionId/);
  assert.match(query, /tree\.id = @tree_id AND tree\.deleted_at IS NULL AND tree\.is_private = 1/);
  assert.match(query, /LOWER\(LTRIM\(RTRIM\(tree\.display_name\)\)\) = N'personal cache'/);
  assert.match(query, /tree\.owner_object_id = @owner AND app\.app_identifier = @application_identifier/);
  assert.match(query, /interactions\.parent_id IS NULL AND interactions\.text = N'Interactions'/);
  assert.match(query, /by_id\.text = N'By Interaction ID'/);
  assert.match(query, /interaction\.deleted_at IS NULL AND interaction\.is_leaf_node = 1/);
  assert.match(query, /details\.updated_at > DATEADD\(HOUR, -24, SYSUTCDATETIME\(\)\)/);
  assert.match(query, /ISJSON\(details\.notes\) = 1/);
  assert.match(query, /'\$\.schemaVersion'\) = N'1'/);
  assert.match(query, /'\$\.id'\) = interaction\.text/);
  assert.match(query, /'\$\.workflow'\) = @workflow/);
  assert.match(query, /'\$\.status'\) = N'active'/);
  assert.match(query, /ORDER BY details\.updated_at DESC, interaction\.id DESC/);
  assert.match(query, /child\.parent_id = interaction\.id/);
  assert.match(query, /files\.tree_node_id = interaction\.id/);
  assert.doesNotMatch(query, /conversationId|'\$\.pending'|'\$\.updatedAt'|UPDATE |INSERT |DELETE /);
});

test('no match is explicit null and authentication/database errors propagate without fallback', async () => {
  globalThis.__lookupInteractions = async () => ({ recordset: [] });
  assert.equal(await findLatestActiveInteractionId(options), null);
  await assert.rejects(findLatestActiveInteractionId({ ...options, principal: null }), /authenticated principal/);
  globalThis.__lookupInteractions = async () => { throw new Error('Lookup unavailable'); };
  await assert.rejects(findLatestActiveInteractionId(options), /Lookup unavailable/);
});
