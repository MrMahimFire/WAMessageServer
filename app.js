'use strict';

const express = require('express');
const cors = require('cors');
const { createWebhookService } = require('./webhookService');
const { createWebhookRouter } = require('./routes/webhook');
const { createAdminRouter } = require('./routes/admin');
const { createRateLimiter, requireAdmin, securityHeaders, notFound, createErrorHandler } = require('./middleware');

function createApp({ config, store, box, whatsapp, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders);
  if (config.corsOrigins.length > 0) {
    app.use(cors({
      origin: config.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-API-Key'],
      maxAge: 600,
    }));
  }

  // The raw body is kept so the webhook signature can be verified byte-for-byte.
  app.use(express.json({
    limit: '256kb',
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

  app.get('/', (req, res) => res.json({ status: 'ok', service: 'whatsapp-auto-reply-server' }));
  app.get('/health', (req, res) => {
    let dbOk = false;
    try { dbOk = store.ping(); } catch { /* reported below */ }
    res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'degraded' });
  });

  const service = createWebhookService({ store, box, whatsapp, config, logger });
  app.use(createWebhookRouter({ config, service, logger }));

  const apiLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120 });
  const failureLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
  app.use(
    '/api/v1',
    apiLimiter.middleware,
    requireAdmin({ apiKeys: config.adminApiKeys, failureLimiter }),
    createAdminRouter({ store, box, whatsapp, config, logger }),
  );

  app.use(notFound);
  app.use(createErrorHandler(logger));
  return { app, service };
}

module.exports = { createApp };
