'use strict';

const SENSITIVE_KEY = /token|secret|key|password|authorization|signature|cookie/i;
const PATTERNS = [
  /EAA[A-Za-z0-9]{10,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(access_token|verify_token|token|secret|key|password)=([^&\s]+)/gi,
];

function redact(value) {
  let s = String(value);
  for (const p of PATTERNS) s = s.replace(p, '[redacted]');
  return s;
}

function sanitizeMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (SENSITIVE_KEY.test(k)) out[k] = '[redacted]';
    else if (typeof v === 'string') out[k] = redact(v);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (v !== undefined) out[k] = redact(JSON.stringify(v));
  }
  return out;
}

function createLogger({ sink = console } = {}) {
  function log(level, message, meta) {
    const line = JSON.stringify({ time: new Date().toISOString(), level, msg: redact(message), ...sanitizeMeta(meta) });
    (level === 'error' ? sink.error : level === 'warn' ? sink.warn : sink.log).call(sink, line);
  }
  return {
    info: (m, meta) => log('info', m, meta),
    warn: (m, meta) => log('warn', m, meta),
    error: (m, meta) => log('error', m, meta),
  };
}

module.exports = { createLogger, redact };
