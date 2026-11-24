import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptLaneContext, buildLaneRequestContext } from './chatLaneContext.js';

test('chat sends only stable identity and version, and adopts server context on success or error', () => {
  const context = { conversationId: 'conversation-a', version: 2, activeLane: 'knowledge.saving' };
  assert.deepEqual(buildLaneRequestContext(context, 'turn-a'), {
    conversationId: 'conversation-a', turnId: 'turn-a', expectedVersion: 2,
  });
  const payload = { error: 'The turn failed', laneContext: { ...context, version: 4 } };
  assert.deepEqual(acceptLaneContext(context, payload), { conversationId: 'conversation-a', version: 4 });
  assert.equal(acceptLaneContext(context, {}), context);
});

test('late responses cannot overwrite another conversation or a newer version', () => {
  const context = { conversationId: 'conversation-a', version: 4 };
  for (const laneContext of [
    { conversationId: 'conversation-b', version: 5 },
    { conversationId: 'conversation-a', version: 3 },
    { conversationId: 'conversation-a', version: '5' },
  ]) {
    assert.throws(() => acceptLaneContext(context, { laneContext }), /invalid or outdated/);
  }
});
