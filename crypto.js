'use strict';

const crypto = require('node:crypto');

function parseEncryptionKey(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('ENCRYPTION_KEY is missing');
  const v = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex characters or base64)');
  }
  return buf;
}

/** Constant-time string comparison (hashes first so lengths never leak). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Verifies Meta's X-Hub-Signature-256 header ("sha256=<hex>") against the raw request body. */
function verifyMetaSignature(rawBody, header, appSecret) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== 'string' || !appSecret) return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(m[1], 'hex'));
}

function createCryptoBox(rawKey) {
  const key = parseEncryptionKey(rawKey);
  const idKey = Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), 'contact-id-v1', 32));

  function encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  }

  function decrypt(payload) {
    try {
      const parts = String(payload || '').split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('format');
      const iv = Buffer.from(parts[1], 'base64url');
      const tag = Buffer.from(parts[2], 'base64url');
      const ct = Buffer.from(parts[3], 'base64url');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('decryption failed');
    }
  }

  /** Stable, non-reversible identifier for a contact (the phone number itself is not stored). */
  function contactId(accountId, waId) {
    return crypto.createHmac('sha256', idKey).update(`${accountId}:${waId}`).digest('hex');
  }

  return { encrypt, decrypt, contactId };
}

module.exports = { parseEncryptionKey, createCryptoBox, safeEqual, verifyMetaSignature };
