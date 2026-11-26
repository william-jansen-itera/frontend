import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptLaneContext, buildInteractionReplyContext, buildLaneRequestContext, getInteractionReplyTarget, isInteractionAvailable } from './chatLaneContext.js';

test('active cards default to response mode and follow clarification and advancement until normal chat is selected', () => {
  const card = { interactionId: 'interaction-1', stepId: 'topic', version: 3,
    workflow: 'structured-input', status: 'active', allowedActions: ['continue', 'cancel'] };
  for (const current of [card, { ...card, version: 4 }, { ...card, stepId: 'note', version: 5 }]) {
    assert.equal(getInteractionReplyTarget(current, 'knowledgeTrees', 'knowledge.retrieval', false), current);
    assert.equal(getInteractionReplyTarget(current, 'knowledgeTrees', 'knowledge.retrieval', true), null);
  }
  for (const status of ['completed', 'cancelled', 'pending']) {
    assert.equal(getInteractionReplyTarget({ ...card, status }, 'knowledgeTrees', 'quiz', false), null);
  }
  assert.equal(getInteractionReplyTarget({ ...card, allowedActions: ['resume'] }, 'knowledgeTrees', 'quiz', false), null);
  assert.equal(getInteractionReplyTarget(null, 'knowledgeTrees', 'quiz', false), null);
  assert.equal(getInteractionReplyTarget(card, 'email', 'quiz', false), null);
  const quiz = { ...card, workflow: 'interaction-test' };
  assert.equal(getInteractionReplyTarget(quiz, 'knowledgeTrees', 'quiz', false), null);
  assert.equal(getInteractionReplyTarget(quiz, 'knowledgeTrees', 'knowledge.retrieval', false), null);
});

test('ordinary chat stays separate while explicit replies bind the exact current step and workflow', () => {
  const card = { interactionId: 'interaction-1', stepId: 'topic', version: 3, workflow: 'structured-input', status: 'active' };
  assert.equal(buildInteractionReplyContext(null, card, 'knowledgeTrees', 'knowledge.retrieval'), null);
  assert.deepEqual(buildInteractionReplyContext(card, card, 'knowledgeTrees', 'knowledge.saving'), {
    interactionId: card.interactionId, stepId: 'topic', version: 3, workflow: 'structured-input',
  });
  for (const changed of [{ version: 4 }, { stepId: 'note' }, { workflow: 'interaction-test' }, { status: 'pending' }]) {
    assert.throws(() => buildInteractionReplyContext(card, { ...card, ...changed }, 'knowledgeTrees', 'knowledge.retrieval'), /target changed/);
  }
  assert.throws(() => buildInteractionReplyContext(card, card, 'email', 'quiz'), /target changed/);
  assert.equal(isInteractionAvailable({ workflow: 'interaction-test' }, 'knowledgeTrees', 'knowledge.retrieval'), false);
  assert.equal(isInteractionAvailable({ workflow: 'interaction-test' }, 'knowledgeTrees', 'quiz'), true);
});

test('chat sends only stable identity and version, and adopts server context on success or error', () => {
  const context = { conversationId: 'conversation-a', version: 2, activeLane: 'knowledge.saving' };
  assert.deepEqual(buildLaneRequestContext(context, 'turn-a'), {
    conversationId: 'conversation-a', turnId: 'turn-a', expectedVersion: 2,
  });
  const payload = { error: 'The turn failed', laneContext: { ...context, version: 4 } };
  assert.deepEqual(acceptLaneContext(context, payload), { conversationId: 'conversation-a', version: 4, activeLane: 'knowledge.saving' });
  assert.equal(acceptLaneContext(context, {}), context);
});

test('the browser retains the authoritative lane for quiz controls but never sends it as authority', () => {
  const initial = { conversationId: 'conversation-a', version: 0 };
  const quiz = acceptLaneContext(initial, { laneContext: { ...initial, version: 3, activeLane: 'quiz' } });
  assert.equal(quiz.activeLane, 'quiz');
  const retrieval = acceptLaneContext(quiz, { laneContext: { ...quiz, version: 5, activeLane: 'knowledge.retrieval' } });
  assert.equal(retrieval.activeLane, 'knowledge.retrieval');
  assert.deepEqual(buildLaneRequestContext(retrieval, 'turn-b'), {
    conversationId: 'conversation-a', expectedVersion: 5, turnId: 'turn-b',
  });
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
