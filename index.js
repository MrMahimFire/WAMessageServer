'use strict';

const crypto = require('node:crypto');
const { loadConfig } = require('./src/config');
const { createLogger } = require('./src/logger');
const { createCryptoBox } = require('./src/crypto');
const { openDatabase } = require('./src/db');
const { createWhatsAppClient } = require('./src/whatsappClient');
const { createApp } = require('./src/app');

const logger = createLogger();

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message); // names missing variables only, never values
  process.exit(1);
}

const box = createCryptoBox(config.encryptionKey);
const store = openDatabase(config.databasePath);
const whatsapp = createWhatsAppClient({ graphVersion: config.graphApiVersion });

// Optional single-number bootstrap from environment variables (token stays in the environment).
if (config.bootstrapAccount && !store.getAccountByPhoneNumberId(config.bootstrapAccount.phoneNumberId)) {
  store.createAccount({
    id: crypto.randomUUID(),
    label: 'Primary number',
    phoneNumberId: config.bootstrapAccount.phoneNumberId,
    businessAccountId: config.bootstrapAccount.businessAccountId,
    accessTokenEnc: null,
  });
  logger.info('bootstrap account created from environment');
}

const { app } = createApp({ config, store, box, whatsapp, logger });
const server = app.listen(config.port, () => logger.info('server started', { port: config.port }));

const maintenance = setInterval(() => {
  try {
    const removed = store.prune(config.logRetentionDays);
    logger.info('maintenance finished', removed);
  } catch (e) {
    logger.error('maintenance failed', { error: e.message });
  }
}, 6 * 60 * 60 * 1000);
maintenance.unref();

function shutdown(signal) {
  logger.info('shutting down', { signal });
  server.close(() => {
    try { store.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logger.error('unhandled rejection', { error: e && e.message }));
