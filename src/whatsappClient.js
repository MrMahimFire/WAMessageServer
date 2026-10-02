'use strict';

/** Thrown for any failed WhatsApp Cloud API call. Carries only numeric codes — never the response body. */
class WhatsAppApiError extends Error {
  constructor(status, code, subcode) {
    super('WhatsApp API request failed');
    this.name = 'WhatsAppApiError';
    this.status = status;
    this.code = code ?? null;
    this.subcode = subcode ?? null;
  }
}

function createWhatsAppClient({
  graphVersion,
  baseUrl = 'https://graph.facebook.com',
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
}) {
  /** Sends a plain text message through the official WhatsApp Cloud API. */
  async function sendText({ phoneNumberId, accessToken, to, body }) {
    const url = `${baseUrl}/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new WhatsAppApiError(0, e && e.name === 'TimeoutError' ? 'timeout' : 'network', null);
    }

    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }

    if (!res.ok) {
      const err = (data && data.error) || {};
      throw new WhatsAppApiError(res.status, err.code, err.error_subcode);
    }
    return { messageId: (data && data.messages && data.messages[0] && data.messages[0].id) || null };
  }

  return { sendText };
}

module.exports = { createWhatsAppClient, WhatsAppApiError };
