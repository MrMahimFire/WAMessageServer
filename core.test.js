'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { createCryptoBox, verifyMetaSignature } = require('../src/crypto');
const { openDatabase } = require('../src/db');
const { matchRule, decideReplies } = require('../src/replyEngine');
const { createWebhookService } = require('../src/webhookService');
const { createWhatsAppClient, WhatsAppApiError } = require('../src/whatsappClient');
const V = require('../src/validators');
const { createLogger, redact } = require('../src/logger');

const KEY = crypto.randomBytes(32).toString('hex');
const baseEnv = () => ({
  ADMIN_API_KEYS: 'a'.repeat(32),
  WEBHOOK_VERIFY_TOKEN: 'verify-me',
  WHATSAPP_APP_SECRET: 'app-secret',
  ENCRYPTION_KEY: KEY,
});
const silent = { info() {}, warn() {}, error() {} };

test('config: valid environment loads, secrets are required', () => {
  const cfg = loadConfig(baseEnv());
  assert.equal(cfg.port, 7860);
  assert.equal(cfg.bootstrapAccount, null);
  for (const missing of ['ADMIN_API_KEYS', 'WEBHOOK_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'ENCRYPTION_KEY']) {
    const env = baseEnv();
    delete env[missing];
    assert.throws(() => loadConfig(env), (e) => e.message.includes(missing) && !e.message.includes(KEY));
  }
});

test('config: short admin key, bad encryption key and partial bootstrap are rejected', () => {
  assert.throws(() => loadConfig({ ...baseEnv(), ADMIN_API_KEYS: 'short' }), /ADMIN_API_KEYS/);
  assert.throws(() => loadConfig({ ...baseEnv(), ENCRYPTION_KEY: 'abc' }), /ENCRYPTION_KEY/);
  assert.throws(() => loadConfig({ ...baseEnv(), WHATSAPP_PHONE_NUMBER_ID: '12345678' }), /set together/);
  assert.throws(() => loadConfig({ ...baseEnv(), WHATSAPP_APP_SECRET: '', NODE_ENV: 'production', ALLOW_UNSIGNED_WEBHOOKS: 'true' }), /production/);
});

test('crypto: round trip, tamper detection, signature verification', () => {
  const box = createCryptoBox(KEY);
  const enc = box.encrypt('EAAGsecretTokenValue123456');
  assert.ok(!enc.includes('secretToken'));
  assert.equal(box.decrypt(enc), 'EAAGsecretTokenValue123456');
  assert.throws(() => box.decrypt(enc.slice(0, -2) + 'AA'), /decryption failed/);
  assert.throws(() => createCryptoBox(crypto.randomBytes(32).toString('hex')).decrypt(enc), /decryption failed/);

  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(body).digest('hex');
  assert.equal(verifyMetaSignature(body, sig, 'app-secret'), true);
  assert.equal(verifyMetaSignature(body, sig, 'other'), false);
  assert.equal(verifyMetaSignature(body, 'sha256=00', 'app-secret'), false);
  assert.equal(verifyMetaSignature(undefined, sig, 'app-secret'), false);
});

test('db: data survives close/reopen; cascade delete works', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-'));
  const file = path.join(dir, 'x.db');
  let store = openDatabase(file);
  store.createAccount({ id: 'acc-1', label: 'Shop', phoneNumberId: '111111', businessAccountId: '222222', accessTokenEnc: 'enc' });
  store.updateAccount('acc-1', { autoReplyEnabled: true, welcomeEnabled: true, welcomeMessage: 'Hi' });
  store.createRule({ id: 'r1', accountId: 'acc-1', keyword: 'price', matchType: 'contains', replyText: '100', priority: 1 });
  store.close();

  store = openDatabase(file);
  const acc = store.getAccount('acc-1');
  assert.equal(acc.autoReplyEnabled, true);
  assert.equal(acc.welcomeMessage, 'Hi');
  assert.equal(store.listRules('acc-1').length, 1);
  assert.equal(store.touchContact('acc-1', 'h1').isNew, true);
  assert.equal(store.touchContact('acc-1', 'h1').isNew, false);
  assert.equal(store.markProcessed('wamid.1', 'acc-1'), true);
  assert.equal(store.markProcessed('wamid.1', 'acc-1'), false);
  assert.equal(store.deleteAccount('acc-1'), true);
  assert.equal(store.listRules('acc-1').length, 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reply engine: matching and decision rules', () => {
  const rules = [
    { keyword: 'Hello', matchType: 'exact', replyText: 'exact-hello' },
    { keyword: 'price', matchType: 'contains', replyText: 'price-info' },
    { keyword: 'অর্ডার', matchType: 'starts_with', replyText: 'order-info' },
  ];
  assert.equal(matchRule(rules, '  HELLO ').replyText, 'exact-hello');
  assert.equal(matchRule(rules, 'hello there'), null);
  assert.equal(matchRule(rules, 'What is the PRICE?').replyText, 'price-info');
  assert.equal(matchRule(rules, 'অর্ডার করতে চাই').replyText, 'order-info');
  assert.equal(matchRule(rules, ''), null);

  const account = { autoReplyEnabled: true, welcomeEnabled: true, welcomeMessage: 'Welcome', defaultReplyEnabled: true, defaultReplyMessage: 'Default' };
  const kinds = (o) => decideReplies({ account, rules, ...o }).map((r) => r.kind);
  assert.deepEqual(kinds({ text: 'x', isNewContact: true }), ['welcome']);
  assert.deepEqual(kinds({ text: 'price?', isNewContact: true }), ['welcome', 'keyword']);
  assert.deepEqual(kinds({ text: 'x', isNewContact: false }), ['default']);
  assert.deepEqual(kinds({ text: 'price', isNewContact: false }), ['keyword']);
  assert.deepEqual(decideReplies({ account: { ...account, autoReplyEnabled: false }, rules, text: 'price', isNewContact: true }), []);
});

function makeService({ send, config = {} } = {}) {
  const store = openDatabase(':memory:');
  const box = createCryptoBox(KEY);
  const sent = [];
  const whatsapp = { sendText: send || (async (a) => { sent.push(a); return { messageId: 'wamid.out' }; }) };
  const cfg = { defaultAccessToken: null, storeMessageText: false, ...config };
  const service = createWebhookService({ store, box, whatsapp, config: cfg, logger: silent });
  store.createAccount({
    id: 'acc-1', label: 'Shop', phoneNumberId: '555000', businessAccountId: '777000',
    accessTokenEnc: box.encrypt('EAAtesttokenvalue1234567890'),
    autoReplyEnabled: true, welcomeEnabled: true, welcomeMessage: 'Welcome!', defaultReplyEnabled: true, defaultReplyMessage: 'Default',
  });
  store.createRule({ id: 'r1', accountId: 'acc-1', keyword: 'hours', matchType: 'contains', replyText: '9 to 5' });
  return { store, service, sent };
}

const payload = (id, from, text, phoneId = '555000') => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneId }, messages: [{ id, from, type: 'text', text: { body: text } }] } }] }],
});

test('webhook service: welcome, keyword, default, dedupe and token usage', async () => {
  const { store, service, sent } = makeService();

  await service.handlePayload(payload('m1', '8801700000001', 'hi'));
  assert.deepEqual(sent.map((s) => s.body), ['Welcome!']);
  assert.equal(sent[0].accessToken, 'EAAtesttokenvalue1234567890');
  assert.equal(sent[0].to, '8801700000001');

  await service.handlePayload(payload('m1', '8801700000001', 'hi')); // redelivery
  assert.equal(sent.length, 1);

  await service.handlePayload(payload('m2', '8801700000001', 'opening HOURS?'));
  await service.handlePayload(payload('m3', '8801700000001', 'something else'));
  assert.deepEqual(sent.map((s) => s.body), ['Welcome!', '9 to 5', 'Default']);

  const logs = store.listLogs('acc-1', 50);
  assert.ok(logs.every((l) => l.contact === '****0001' && l.text === null));
});

test('webhook service: unknown number, statuses and auto-reply OFF send nothing', async () => {
  const { store, service, sent } = makeService();
  await service.handlePayload(payload('a1', '8801700000002', 'hi', '999999'));
  await service.handlePayload({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '555000' }, statuses: [{ id: 'x' }] } }] }] });
  store.updateAccount('acc-1', { autoReplyEnabled: false });
  await service.handlePayload(payload('a2', '8801700000002', 'hours'));
  assert.equal(sent.length, 0);
});

test('webhook service: send failure is contained and logged without secrets', async () => {
  const { store, service } = makeService({ send: async () => { throw new WhatsAppApiError(401, 190, null); } });
  await service.handlePayload(payload('f1', '8801700000003', 'hours'));
  const [last] = store.listLogs('acc-1', 1);
  assert.equal(last.status, 'failed');
  assert.equal(last.errorCode, '190');
});

test('whatsapp client: request shape and error handling', async () => {
  let captured;
  const ok = createWhatsAppClient({
    graphVersion: 'v23.0',
    fetchImpl: async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => ({ messages: [{ id: 'wamid.123' }] }) }; },
  });
  const r = await ok.sendText({ phoneNumberId: '555000', accessToken: 'tok', to: '8801', body: 'Hello' });
  assert.equal(r.messageId, 'wamid.123');
  assert.equal(captured.url, 'https://graph.facebook.com/v23.0/555000/messages');
  assert.equal(captured.opts.headers.Authorization, 'Bearer tok');
  assert.ok(!captured.url.includes('tok'));
  assert.equal(JSON.parse(captured.opts.body).messaging_product, 'whatsapp');

  const bad = createWhatsAppClient({
    graphVersion: 'v23.0',
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 131030, message: 'secret-looking text EAAxxxxxxxxxxxxxxxx' } }) }),
  });
  await assert.rejects(bad.sendText({ phoneNumberId: '1', accessToken: 't', to: '2', body: 'x' }), (e) => e.code === 131030 && !e.message.includes('EAA'));
  const net = createWhatsAppClient({ graphVersion: 'v23.0', fetchImpl: async () => { throw new Error('boom'); } });
  await assert.rejects(net.sendText({ phoneNumberId: '1', accessToken: 't', to: '2', body: 'x' }), (e) => e.code === 'network');
});

test('validators: accept good input, reject bad input', () => {
  assert.equal(V.validateAccountCreate({ label: 'A', phoneNumberId: '12345678', businessAccountId: '87654321', accessToken: 'x'.repeat(30) }).errors.length, 0);
  assert.ok(V.validateAccountCreate({ label: '', phoneNumberId: 'abc' }).errors.length >= 3);
  assert.ok(V.validateAccountPatch({}).errors.length > 0);
  assert.ok(V.validateAccountPatch({ autoReplyEnabled: 'yes' }).errors.length > 0);
  assert.ok(V.checkAccountConsistency({ welcomeEnabled: true, welcomeMessage: ' ' }).length > 0);
  assert.equal(V.validateRuleCreate({ keyword: 'hi', replyText: 'yo' }).value.matchType, 'contains');
  assert.ok(V.validateRuleCreate({ keyword: 'hi', replyText: 'yo', matchType: 'regex' }).errors.length > 0);
  assert.ok(V.validateTestMessage({ to: '+880', text: 'x' }).errors.length > 0);
});

test('logger: secrets are redacted', () => {
  assert.ok(!redact('Bearer EAAabcdefghijklmnop123 and access_token=abc123').includes('abc123'));
  const lines = [];
  const log = createLogger({ sink: { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) } });
  log.error('failed', { accessToken: 'EAAsupersecretvalue123456', note: 'token=abc' });
  assert.ok(!lines[0].includes('supersecret') && !lines[0].includes('abc'));
});
