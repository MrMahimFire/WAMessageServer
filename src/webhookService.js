'use strict';

const { decideReplies } = require('./replyEngine');

const maskNumber = (n) => `****${String(n).slice(-4)}`;

/** Pulls the user's text out of the different WhatsApp incoming message types. */
function extractText(msg) {
  switch (msg.type) {
    case 'text': return (msg.text && msg.text.body) || '';
    case 'button': return (msg.button && (msg.button.text || msg.button.payload)) || '';
    case 'interactive': {
      const i = msg.interactive || {};
      return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || '';
    }
    default: return '';
  }
}

function createWebhookService({ store, box, whatsapp, config, logger }) {
  function resolveToken(account) {
    if (account.accessTokenEnc) return box.decrypt(account.accessTokenEnc);
    return config.defaultAccessToken;
  }

  function log(account, direction, mask, kind, status, errorCode, text) {
    try {
      store.addLog({
        accountId: account.id, direction, contactMask: mask, kind, status, errorCode,
        text: config.storeMessageText && text ? String(text).slice(0, 500) : null,
      });
    } catch (e) {
      logger.error('failed to write message log', { error: e.message });
    }
  }

  async function processMessage(account, msg) {
    if (!msg || !msg.id || !msg.from) return;
    if (!store.markProcessed(msg.id, account.id)) return; // duplicate delivery

    const mask = maskNumber(msg.from);
    const text = extractText(msg);
    const { isNew } = store.touchContact(account.id, box.contactId(account.id, msg.from));
    log(account, 'in', mask, msg.type || 'unknown', 'received', null, text);

    const replies = decideReplies({
      account,
      rules: store.listActiveRules(account.id),
      text,
      isNewContact: isNew,
    });
    if (replies.length === 0) return;

    let token;
    try {
      token = resolveToken(account);
    } catch {
      token = null;
    }
    if (!token) {
      logger.error('no usable access token for account', { accountId: account.id });
      log(account, 'out', mask, 'auto', 'failed', 'no_token');
      return;
    }

    for (const reply of replies) {
      try {
        await whatsapp.sendText({ phoneNumberId: account.phoneNumberId, accessToken: token, to: msg.from, body: reply.text });
        log(account, 'out', mask, reply.kind, 'sent', null, reply.text);
      } catch (e) {
        const code = e && e.code != null ? String(e.code) : 'error';
        logger.warn('failed to send reply', { accountId: account.id, status: e && e.status, code });
        log(account, 'out', mask, reply.kind, 'failed', code);
        break; // do not keep hammering the API if sending is failing
      }
    }
  }

  async function handlePayload(payload) {
    if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return;
    for (const entry of payload.entry) {
      for (const change of (entry && entry.changes) || []) {
        if (!change || change.field !== 'messages' || !change.value) continue;
        const phoneNumberId = change.value.metadata && change.value.metadata.phone_number_id;
        const messages = change.value.messages;
        if (!phoneNumberId || !Array.isArray(messages) || messages.length === 0) continue; // statuses etc.

        const account = store.getAccountByPhoneNumberId(String(phoneNumberId));
        if (!account) {
          logger.warn('webhook received for a number that is not configured');
          continue;
        }
        for (const msg of messages) {
          try {
            await processMessage(account, msg);
          } catch (e) {
            logger.error('failed to process incoming message', { accountId: account.id, error: e.message });
          }
        }
      }
    }
  }

  return { handlePayload, processMessage };
}

module.exports = { createWebhookService, extractText, maskNumber };
