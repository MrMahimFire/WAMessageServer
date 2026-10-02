'use strict';

const crypto = require('node:crypto');
const express = require('express');
const V = require('../validators');
const { publicAccount, publicRule } = require('../serializers');
const { WhatsAppApiError } = require('../whatsappClient');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RULES_PER_ACCOUNT = 200;

/**
 * Admin API used by the Android app / web panel. Mounted at /api/v1 behind authentication.
 */
function createAdminRouter({ store, box, whatsapp, config, logger }) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const fail = (res, status, error, details) => res.status(status).json({ success: false, error, ...(details ? { details } : {}) });

  router.param('accountId', (req, res, next, id) => {
    const account = UUID.test(id) ? store.getAccount(id) : null;
    if (!account) return fail(res, 404, 'account not found');
    req.account = account;
    return next();
  });

  router.param('ruleId', (req, res, next, id) => {
    const rule = UUID.test(id) ? store.getRule(req.account.id, id) : null;
    if (!rule) return fail(res, 404, 'rule not found');
    req.rule = rule;
    return next();
  });

  // ── Accounts (one per connected WhatsApp Business number) ──────────────
  router.get('/accounts', (req, res) => {
    res.json({ success: true, accounts: store.listAccounts().map(publicAccount) });
  });

  router.post('/accounts', (req, res) => {
    const { errors, value } = V.validateAccountCreate(req.body);
    if (errors.length) return fail(res, 400, 'validation failed', errors);

    const consistency = V.checkAccountConsistency(value);
    if (consistency.length) return fail(res, 400, 'validation failed', consistency);
    if (!value.accessToken && !config.defaultAccessToken) {
      return fail(res, 400, 'validation failed', ['accessToken is required']);
    }
    if (store.getAccountByPhoneNumberId(value.phoneNumberId)) {
      return fail(res, 409, 'this phone number is already configured');
    }

    const { accessToken, ...rest } = value;
    const account = store.createAccount({
      id: crypto.randomUUID(),
      ...rest,
      accessTokenEnc: accessToken ? box.encrypt(accessToken) : null,
    });
    return res.status(201).json({ success: true, account: publicAccount(account) });
  });

  router.get('/accounts/:accountId', (req, res) => {
    res.json({ success: true, account: publicAccount(req.account) });
  });

  router.patch('/accounts/:accountId', (req, res) => {
    const { errors, value } = V.validateAccountPatch(req.body);
    if (errors.length) return fail(res, 400, 'validation failed', errors);

    const { accessToken, ...rest } = value;
    const consistency = V.checkAccountConsistency({ ...req.account, ...rest });
    if (consistency.length) return fail(res, 400, 'validation failed', consistency);

    const patch = { ...rest };
    if (accessToken) patch.accessTokenEnc = box.encrypt(accessToken);
    const account = store.updateAccount(req.account.id, patch);
    return res.json({ success: true, account: publicAccount(account) });
  });

  router.delete('/accounts/:accountId', (req, res) => {
    store.deleteAccount(req.account.id);
    res.json({ success: true });
  });

  router.put('/accounts/:accountId/auto-reply', (req, res) => {
    const { errors, value } = V.validateAutoReplyToggle(req.body);
    if (errors.length) return fail(res, 400, 'validation failed', errors);
    const account = store.updateAccount(req.account.id, { autoReplyEnabled: value.enabled });
    return res.json({ success: true, account: publicAccount(account) });
  });

  // ── Keyword rules ──────────────────────────────────────────────────────
  router.get('/accounts/:accountId/rules', (req, res) => {
    res.json({ success: true, rules: store.listRules(req.account.id).map(publicRule) });
  });

  router.post('/accounts/:accountId/rules', (req, res) => {
    const { errors, value } = V.validateRuleCreate(req.body);
    if (errors.length) return fail(res, 400, 'validation failed', errors);
    if (store.countRules(req.account.id) >= MAX_RULES_PER_ACCOUNT) {
      return fail(res, 400, `rule limit reached (${MAX_RULES_PER_ACCOUNT} per account)`);
    }
    const rule = store.createRule({ id: crypto.randomUUID(), accountId: req.account.id, ...value });
    return res.status(201).json({ success: true, rule: publicRule(rule) });
  });

  router.patch('/accounts/:accountId/rules/:ruleId', (req, res) => {
    const { errors, value } = V.validateRulePatch(req.body);
    if (errors.length) return fail(res, 400, 'validation failed', errors);
    const rule = store.updateRule(req.account.id, req.rule.id, value);
    return res.json({ success: true, rule: publicRule(rule) });
  });

  router.delete('/accounts/:accountId/rules/:ruleId', (req, res) => {
    store.deleteRule(req.account.id, req.rule.id);
    res.json({ success: true });
  });

  // ── Activity log (contacts are masked; text only stored if STORE_MESSAGE_TEXT=true) ──
  router.get('/accounts/:accountId/logs', (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    res.json({ success: true, logs: store.listLogs(req.account.id, limit) });
  });

  // ── Send a test message to verify the access token / number setup ─────
  router.post('/accounts/:accountId/test-message', wrap(async (req, res) => {
    const { errors, value } = V.validateTestMessage(req.body);
    if (errors.length) return fail(res, 400, 'validation failed', errors);

    let token;
    try {
      token = req.account.accessTokenEnc ? box.decrypt(req.account.accessTokenEnc) : config.defaultAccessToken;
    } catch {
      token = null;
    }
    if (!token) return fail(res, 409, 'no usable access token for this account');

    try {
      const result = await whatsapp.sendText({
        phoneNumberId: req.account.phoneNumberId, accessToken: token, to: value.to, body: value.text,
      });
      return res.json({ success: true, messageId: result.messageId });
    } catch (e) {
      if (e instanceof WhatsAppApiError) {
        logger.warn('test message failed', { accountId: req.account.id, status: e.status, code: String(e.code) });
        return res.status(502).json({ success: false, error: 'whatsapp api request failed', code: e.code, status: e.status });
      }
      throw e;
    }
  }));

  return router;
}

module.exports = { createAdminRouter };
