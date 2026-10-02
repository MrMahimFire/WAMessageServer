'use strict';

const { safeEqual } = require('./crypto');

/** Small in-memory fixed-window counter keyed by client IP. */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60000));
  if (timer.unref) timer.unref();

  function entry(key) {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset <= now) {
      if (hits.size > 20000) hits.clear();
      e = { count: 0, reset: now + windowMs };
      hits.set(key, e);
    }
    return e;
  }

  function hit(key) { const e = entry(key); e.count += 1; return e; }
  function peek(key) {
    const e = entry(key);
    return { count: e.count, retryAfter: Math.max(1, Math.ceil((e.reset - Date.now()) / 1000)) };
  }
  function middleware(req, res, next) {
    const e = hit(req.ip || 'unknown');
    if (e.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((e.reset - Date.now()) / 1000))));
      return res.status(429).json({ success: false, error: 'too many requests' });
    }
    return next();
  }
  return { max, hit, peek, middleware };
}

/** Bearer / X-API-Key authentication for the admin API, with lock-out after repeated failures. */
function requireAdmin({ apiKeys, failureLimiter }) {
  return function adminAuth(req, res, next) {
    const ip = req.ip || 'unknown';
    const state = failureLimiter.peek(ip);
    if (state.count >= failureLimiter.max) {
      res.set('Retry-After', String(state.retryAfter));
      return res.status(429).json({ success: false, error: 'too many failed attempts' });
    }

    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const provided = (m ? m[1] : req.get('x-api-key') || '').trim();

    let ok = false;
    if (provided) {
      for (const key of apiKeys) if (safeEqual(provided, key)) ok = true;
    }
    if (!ok) {
      failureLimiter.hit(ip);
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
    return next();
  };
}

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Strict-Transport-Security': 'max-age=15552000',
  });
  next();
}

function notFound(req, res) {
  res.status(404).json({ success: false, error: 'not found' });
}

/** Never leaks internals: only generic messages go to the client, redacted details go to the log. */
function createErrorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'invalid JSON body' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'payload too large' });
    logger.error('unhandled request error', { name: err && err.name, error: err && err.message });
    return res.status(500).json({ success: false, error: 'internal server error' });
  };
}

module.exports = { createRateLimiter, requireAdmin, securityHeaders, notFound, createErrorHandler };
