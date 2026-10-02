'use strict';

const MATCH_TYPES = ['exact', 'contains', 'starts_with'];
const MAX_MESSAGE = 4096;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readString(body, name, errors, { required = false, min = 0, max = MAX_MESSAGE, pattern, patternHint } = {}) {
  const v = body[name];
  if (v === undefined) {
    if (required) errors.push(`${name} is required`);
    return undefined;
  }
  if (typeof v !== 'string') { errors.push(`${name} must be a string`); return undefined; }
  const s = v.trim();
  if (s.length < min) errors.push(`${name} must be at least ${min} character(s)`);
  if (s.length > max) errors.push(`${name} must be at most ${max} characters`);
  if (pattern && s.length > 0 && !pattern.test(s)) errors.push(`${name} ${patternHint || 'has an invalid format'}`);
  return s;
}

function readBool(body, name, errors) {
  const v = body[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') { errors.push(`${name} must be true or false`); return undefined; }
  return v;
}

function readInt(body, name, errors, min, max) {
  const v = body[name];
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < min || v > max) { errors.push(`${name} must be an integer between ${min} and ${max}`); return undefined; }
  return v;
}

function readEnum(body, name, errors, allowed) {
  const v = body[name];
  if (v === undefined) return undefined;
  if (!allowed.includes(v)) { errors.push(`${name} must be one of: ${allowed.join(', ')}`); return undefined; }
  return v;
}

function strip(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

const ID = /^\d{5,20}$/;
const TOKEN = /^\S{20,1000}$/;
const DISPLAY = /^\+?[\d\s\-()]{5,25}$/;

function accountFields(body, errors, { creating }) {
  return strip({
    label: readString(body, 'label', errors, { required: creating, min: 1, max: 80 }),
    businessAccountId: readString(body, 'businessAccountId', errors, { required: creating, pattern: ID, patternHint: 'must be numeric' }),
    displayPhoneNumber: readString(body, 'displayPhoneNumber', errors, { max: 25, pattern: DISPLAY }),
    accessToken: readString(body, 'accessToken', errors, { pattern: TOKEN, patternHint: 'has an invalid format' }),
    autoReplyEnabled: readBool(body, 'autoReplyEnabled', errors),
    welcomeEnabled: readBool(body, 'welcomeEnabled', errors),
    welcomeMessage: readString(body, 'welcomeMessage', errors, { max: MAX_MESSAGE }),
    defaultReplyEnabled: readBool(body, 'defaultReplyEnabled', errors),
    defaultReplyMessage: readString(body, 'defaultReplyMessage', errors, { max: MAX_MESSAGE }),
  });
}

function validateAccountCreate(body) {
  const errors = [];
  if (!isObject(body)) return { errors: ['JSON body required'] };
  const value = accountFields(body, errors, { creating: true });
  const phoneNumberId = readString(body, 'phoneNumberId', errors, { required: true, pattern: ID, patternHint: 'must be numeric' });
  return { errors, value: { ...value, phoneNumberId } };
}

function validateAccountPatch(body) {
  const errors = [];
  if (!isObject(body)) return { errors: ['JSON body required'] };
  const value = accountFields(body, errors, { creating: false });
  if (Object.keys(value).length === 0 && errors.length === 0) errors.push('no updatable fields provided');
  return { errors, value };
}

/** Checks the final (merged) configuration so enabled features always have a message to send. */
function checkAccountConsistency(cfg) {
  const errors = [];
  if (cfg.welcomeEnabled && !String(cfg.welcomeMessage || '').trim()) errors.push('welcomeMessage is required when welcomeEnabled is true');
  if (cfg.defaultReplyEnabled && !String(cfg.defaultReplyMessage || '').trim()) errors.push('defaultReplyMessage is required when defaultReplyEnabled is true');
  return errors;
}

function validateAutoReplyToggle(body) {
  const errors = [];
  if (!isObject(body)) return { errors: ['JSON body required'] };
  const enabled = readBool(body, 'enabled', errors);
  if (enabled === undefined && errors.length === 0) errors.push('enabled is required');
  return { errors, value: { enabled } };
}

function ruleFields(body, errors, { creating }) {
  return strip({
    keyword: readString(body, 'keyword', errors, { required: creating, min: 1, max: 200 }),
    matchType: readEnum(body, 'matchType', errors, MATCH_TYPES),
    replyText: readString(body, 'replyText', errors, { required: creating, min: 1, max: MAX_MESSAGE }),
    priority: readInt(body, 'priority', errors, -1000, 1000),
    enabled: readBool(body, 'enabled', errors),
  });
}

function validateRuleCreate(body) {
  const errors = [];
  if (!isObject(body)) return { errors: ['JSON body required'] };
  const value = ruleFields(body, errors, { creating: true });
  return { errors, value: { matchType: 'contains', priority: 0, enabled: true, ...value } };
}

function validateRulePatch(body) {
  const errors = [];
  if (!isObject(body)) return { errors: ['JSON body required'] };
  const value = ruleFields(body, errors, { creating: false });
  if (Object.keys(value).length === 0 && errors.length === 0) errors.push('no updatable fields provided');
  return { errors, value };
}

function validateTestMessage(body) {
  const errors = [];
  if (!isObject(body)) return { errors: ['JSON body required'] };
  const to = readString(body, 'to', errors, { required: true, pattern: /^\d{6,15}$/, patternHint: 'must be digits only, in international format without +' });
  const text = readString(body, 'text', errors, { required: true, min: 1, max: MAX_MESSAGE });
  return { errors, value: { to, text } };
}

module.exports = {
  MATCH_TYPES,
  validateAccountCreate,
  validateAccountPatch,
  checkAccountConsistency,
  validateAutoReplyToggle,
  validateRuleCreate,
  validateRulePatch,
  validateTestMessage,
};
