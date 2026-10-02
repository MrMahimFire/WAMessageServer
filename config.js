'use strict';

const path = require('node:path');
const { parseEncryptionKey } = require('./crypto');

const MIN_SECRET_LENGTH = 24;

function str(env, name) {
  const v = env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function bool(env, name, def = false) {
  const v = str(env, name);
  return v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(env, name, def, problems, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = str(env, name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return def;
  }
  return n;
}

function parseTrustProxy(v) {
  if (v === undefined) return false;
  const s = v.toLowerCase();
  if (s === 'true') return 1;
  if (s === 'false') return false;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : false;
}

/**
 * Reads and validates configuration from environment variables.
 * Error messages only ever name variables — never their values.
 */
function loadConfig(env = process.env) {
  const problems = [];
  const isProduction = env.NODE_ENV === 'production';

  const adminApiKeys = (str(env, 'ADMIN_API_KEYS') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (adminApiKeys.length === 0) {
    problems.push(`ADMIN_API_KEYS is required (comma-separated, each at least ${MIN_SECRET_LENGTH} characters)`);
  } else if (adminApiKeys.some((k) => k.length < MIN_SECRET_LENGTH)) {
    problems.push(`every key in ADMIN_API_KEYS must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const webhookVerifyToken = str(env, 'WEBHOOK_VERIFY_TOKEN');
  if (!webhookVerifyToken) problems.push('WEBHOOK_VERIFY_TOKEN is required');

  const encryptionKey = str(env, 'ENCRYPTION_KEY');
  if (!encryptionKey) {
    problems.push('ENCRYPTION_KEY is required');
  } else {
    try { parseEncryptionKey(encryptionKey); } catch (e) { problems.push(e.message); }
  }

  const appSecret = str(env, 'WHATSAPP_APP_SECRET');
  const allowUnsignedWebhooks = bool(env, 'ALLOW_UNSIGNED_WEBHOOKS', false);
  if (!appSecret) {
    if (!allowUnsignedWebhooks) {
      problems.push('WHATSAPP_APP_SECRET is required (needed to verify webhook signatures)');
    } else if (isProduction) {
      problems.push('ALLOW_UNSIGNED_WEBHOOKS cannot be enabled when NODE_ENV=production');
    }
  }

  const bootstrapVars = ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_ACCESS_TOKEN'];
  const bootstrapSet = bootstrapVars.filter((n) => str(env, n));
  if (bootstrapSet.length > 0 && bootstrapSet.length < bootstrapVars.length) {
    problems.push('WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID and WHATSAPP_ACCESS_TOKEN must be set together');
  }
  const phoneId = str(env, 'WHATSAPP_PHONE_NUMBER_ID');
  const wabaId = str(env, 'WHATSAPP_BUSINESS_ACCOUNT_ID');
  if (phoneId && !/^\d{5,20}$/.test(phoneId)) problems.push('WHATSAPP_PHONE_NUMBER_ID must be numeric');
  if (wabaId && !/^\d{5,20}$/.test(wabaId)) problems.push('WHATSAPP_BUSINESS_ACCOUNT_ID must be numeric');

  const graphApiVersion = str(env, 'GRAPH_API_VERSION') || 'v23.0';
  if (!/^v\d{1,2}\.\d$/.test(graphApiVersion)) problems.push('GRAPH_API_VERSION must look like v23.0');

  const port = int(env, 'PORT', 7860, problems, { min: 1, max: 65535 });
  const logRetentionDays = int(env, 'MESSAGE_LOG_RETENTION_DAYS', 30, problems, { min: 1, max: 3650 });

  const dataDir = path.resolve(str(env, 'DATA_DIR') || './data');
  const databasePath = str(env, 'DATABASE_PATH') ? path.resolve(str(env, 'DATABASE_PATH')) : path.join(dataDir, 'whatsapp-server.db');

  if (problems.length > 0) {
    const err = new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    err.code = 'CONFIG_INVALID';
    throw err;
  }

  return Object.freeze({
    isProduction,
    port,
    databasePath,
    trustProxy: parseTrustProxy(str(env, 'TRUST_PROXY')),
    corsOrigins: (str(env, 'CORS_ORIGINS') || '').split(',').map((s) => s.trim()).filter(Boolean),
    adminApiKeys,
    webhookVerifyToken,
    encryptionKey,
    whatsappAppSecret: appSecret || null,
    allowUnsignedWebhooks,
    graphApiVersion,
    logRetentionDays,
    storeMessageText: bool(env, 'STORE_MESSAGE_TEXT', false),
    // Optional environment-based credentials (never persisted to the database).
    defaultAccessToken: str(env, 'WHATSAPP_ACCESS_TOKEN') || null,
    bootstrapAccount: phoneId && wabaId ? { phoneNumberId: phoneId, businessAccountId: wabaId } : null,
  });
}

module.exports = { loadConfig };
