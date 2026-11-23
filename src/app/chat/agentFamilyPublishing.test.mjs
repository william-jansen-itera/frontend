import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildChatPlaceholder } from './agentFamilyPublishing.js';

const families = [
  { family: 'investment', label: 'Investment' },
  { family: 'email', label: 'Email' },
  { family: 'knowledgeTrees', label: 'Knowledge Trees' },
];

test('placeholder follows only the selected family in both languages', () => {
  for (const locale of ['en', 'da']) {
    const messages = JSON.parse(readFileSync(new URL(`../language/${locale}.json`, import.meta.url), 'utf8')).Pages.Chat;
    const phrases = {
      families: {
        email: messages.Placeholders.Email,
        investment: messages.Placeholders.Investment,
        knowledgeTrees: messages.Placeholders.KnowledgeTrees,
      },
    };
    for (const family of families) {
      assert.equal(buildChatPlaceholder(families, family.family, phrases), phrases.families[family.family]);
    }
    if (locale === 'en') {
      assert.equal(buildChatPlaceholder(families, 'email', phrases),
        'Ask me to do something concrete with your email, like find, open, summarize, extract, draft, send, flag, delete, or unsubscribe.');
    }
  }
});

test('no selection or unavailable family uses the empty message', () => {
  const phrases = { empty: 'No agents available' };
  for (const selection of [null, 'unavailable']) {
    assert.equal(buildChatPlaceholder(families, selection, phrases), phrases.empty);
  }
  assert.equal(buildChatPlaceholder([], 'email', phrases), phrases.empty);
});

test('a newly available family without custom help uses only its selected label', () => {
  assert.equal(buildChatPlaceholder([...families, { family: 'calendar', label: 'Calendar' }], 'calendar', {
    single: (label) => `Help with ${label}`,
  }), 'Help with calendar');
});
