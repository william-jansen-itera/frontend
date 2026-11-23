import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

let mailboxSize = 200;
let fetchedRange;
let loggedOut;
globalThis.__retrievalTestClient = class {
  async connect() {}
  async logout() { loggedOut = true; }
  async mailboxOpen() { return { exists: mailboxSize }; }
  async *fetch(range) {
    fetchedRange = range;
    for (let uid = Number(range.split(':')[0]); uid <= mailboxSize; uid += 1) {
      yield { uid, envelope: { subject: `Message ${uid}` }, flags: [] };
    }
  }
};

const stubs = new Map([
  ['imapflow', 'export const ImapFlow = globalThis.__retrievalTestClient;'],
  ['mailparser', 'export const simpleParser = async () => ({ headers: new Map() });'],
  ['nodemailer', 'export default {};'],
  ['nodemailer/lib/mail-composer', 'export default class MailComposer {}'],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs.has(specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs.get(specifier))}`, shortCircuit: true };
    }
    const prefix = '@/server/utils/agent/email/';
    if (specifier.startsWith(prefix)) {
      return nextResolve(new URL(`./${specifier.slice(prefix.length)}.js`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { retrieveEmailsFromImap } = await import('./emailTransport.js');
const account = { imap: {} };

test('refresh retrieves the newest 150 messages and caps oversized scan overrides', async () => {
  for (const scanLimit of [undefined, 150, 500]) {
    loggedOut = false;
    const result = await retrieveEmailsFromImap(account, { returnAllScanned: true, scanLimit });
    assert.equal(fetchedRange, '51:*');
    assert.equal(result.scanLimit, 150);
    assert.equal(result.messages.length, 150);
    assert.equal(result.messages[0].uid, '200');
    assert.equal(result.messages.at(-1).uid, '51');
    assert.equal(loggedOut, true);
  }
});

test('smaller mailboxes still return all available messages', async () => {
  mailboxSize = 40;
  try {
    const result = await retrieveEmailsFromImap(account, { returnAllScanned: true });
    assert.equal(fetchedRange, '1:*');
    assert.equal(result.messages.length, 40);
  } finally {
    mailboxSize = 200;
  }
});

test('the expanded scan preserves the 25-message filtered response cap', async () => {
  const result = await retrieveEmailsFromImap(account, { limit: 150 });
  assert.equal(fetchedRange, '51:*');
  assert.equal(result.messages.length, 25);
  assert.equal(result.messages[0].uid, '200');
  assert.equal(result.messages.at(-1).uid, '176');
});
