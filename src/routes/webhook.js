'use strict';

const express = require('express');
const { safeEqual, verifyMetaSignature } = require('../crypto');

/**
 * WhatsApp Cloud API webhook.
 *  GET  /webhook  – Meta's verification handshake (uses WEBHOOK_VERIFY_TOKEN)
 *  POST /webhook  – incoming messages; signature is checked with the Meta App Secret
 */
function createWebhookRouter({ config, service, logger }) {
  const router = express.Router();

  router.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    const valid =
      mode === 'subscribe' &&
      typeof token === 'string' &&
      typeof challenge === 'string' &&
      /^[\w-]{1,200}$/.test(challenge) &&
      safeEqual(token, config.webhookVerifyToken);
    if (!valid) return res.sendStatus(403);
    return res.status(200).type('text/plain').send(challenge);
  });

  router.post('/webhook', (req, res) => {
    if (config.whatsappAppSecret) {
      const ok = verifyMetaSignature(req.rawBody, req.get('x-hub-signature-256'), config.whatsappAppSecret);
      if (!ok) return res.sendStatus(401);
    } else if (!config.allowUnsignedWebhooks) {
      return res.sendStatus(401);
    }

    // Acknowledge immediately so Meta does not retry; process in the background.
    res.sendStatus(200);
    const payload = req.body;
    setImmediate(() => {
      service.handlePayload(payload).catch((e) => logger.error('webhook processing failed', { error: e.message }));
    });
  });

  return router;
}

module.exports = { createWebhookRouter };
