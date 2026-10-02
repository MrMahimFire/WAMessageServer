'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_V1 = `
CREATE TABLE accounts (
  id                    TEXT PRIMARY KEY,
  label                 TEXT NOT NULL,
  phone_number_id       TEXT NOT NULL UNIQUE,
  business_account_id   TEXT NOT NULL,
  display_phone_number  TEXT,
  access_token_enc      TEXT,
  auto_reply_enabled    INTEGER NOT NULL DEFAULT 0,
  welcome_enabled       INTEGER NOT NULL DEFAULT 0,
  welcome_message       TEXT NOT NULL DEFAULT '',
  default_reply_enabled INTEGER NOT NULL DEFAULT 0,
  default_reply_message TEXT NOT NULL DEFAULT '',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE keyword_rules (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  keyword     TEXT NOT NULL,
  match_type  TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('exact','contains','starts_with')),
  reply_text  TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_rules_account ON keyword_rules(account_id, enabled);

CREATE TABLE contacts (
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_hash TEXT NOT NULL,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  PRIMARY KEY (account_id, contact_hash)
);

CREATE TABLE processed_messages (
  wa_message_id TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  received_at   INTEGER NOT NULL
);
CREATE INDEX idx_processed_received ON processed_messages(received_at);

CREATE TABLE message_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  contact_mask TEXT NOT NULL,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  error_code   TEXT,
  text         TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_log_account ON message_log(account_id, id DESC);
CREATE INDEX idx_log_created ON message_log(created_at);
`;

const ACCOUNT_COLUMNS = {
  label: 'label',
  businessAccountId: 'business_account_id',
  displayPhoneNumber: 'display_phone_number',
  accessTokenEnc: 'access_token_enc',
  autoReplyEnabled: 'auto_reply_enabled',
  welcomeEnabled: 'welcome_enabled',
  welcomeMessage: 'welcome_message',
  defaultReplyEnabled: 'default_reply_enabled',
  defaultReplyMessage: 'default_reply_message',
};

const RULE_COLUMNS = {
  keyword: 'keyword',
  matchType: 'match_type',
  replyText: 'reply_text',
  priority: 'priority',
  enabled: 'enabled',
};

const toDb = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);

function mapAccount(r) {
  if (!r) return null;
  return {
    id: r.id,
    label: r.label,
    phoneNumberId: r.phone_number_id,
    businessAccountId: r.business_account_id,
    displayPhoneNumber: r.display_phone_number,
    accessTokenEnc: r.access_token_enc,
    autoReplyEnabled: !!r.auto_reply_enabled,
    welcomeEnabled: !!r.welcome_enabled,
    welcomeMessage: r.welcome_message,
    defaultReplyEnabled: !!r.default_reply_enabled,
    defaultReplyMessage: r.default_reply_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapRule(r) {
  if (!r) return null;
  return {
    id: r.id,
    accountId: r.account_id,
    keyword: r.keyword,
    matchType: r.match_type,
    replyText: r.reply_text,
    priority: r.priority,
    enabled: !!r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function migrate(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version < 1) {
    db.exec('BEGIN');
    try {
      db.exec(SCHEMA_V1);
      db.exec('PRAGMA user_version = 1');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function buildUpdate(table, columns, id, patch, extraWhere) {
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(columns)) {
    if (patch[key] !== undefined) {
      sets.push(`${col} = ?`);
      params.push(toDb(patch[key]));
    }
  }
  if (sets.length === 0) return null;
  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);
  let sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`;
  if (extraWhere) { sql += ` AND ${extraWhere.sql}`; params.push(extraWhere.param); }
  return { sql, params };
}

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);

  const q = {
    accountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    accountByPhone: db.prepare('SELECT * FROM accounts WHERE phone_number_id = ?'),
    accountsAll: db.prepare('SELECT * FROM accounts ORDER BY created_at ASC'),
    accountInsert: db.prepare(`INSERT INTO accounts
      (id, label, phone_number_id, business_account_id, display_phone_number, access_token_enc,
       auto_reply_enabled, welcome_enabled, welcome_message, default_reply_enabled, default_reply_message,
       created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    accountDelete: db.prepare('DELETE FROM accounts WHERE id = ?'),

    rulesAll: db.prepare('SELECT * FROM keyword_rules WHERE account_id = ? ORDER BY priority DESC, length(keyword) DESC, created_at ASC'),
    rulesActive: db.prepare('SELECT * FROM keyword_rules WHERE account_id = ? AND enabled = 1 ORDER BY priority DESC, length(keyword) DESC, created_at ASC'),
    ruleById: db.prepare('SELECT * FROM keyword_rules WHERE id = ? AND account_id = ?'),
    ruleCount: db.prepare('SELECT COUNT(*) AS n FROM keyword_rules WHERE account_id = ?'),
    ruleInsert: db.prepare(`INSERT INTO keyword_rules
      (id, account_id, keyword, match_type, reply_text, priority, enabled, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`),
    ruleDelete: db.prepare('DELETE FROM keyword_rules WHERE id = ? AND account_id = ?'),

    contactInsert: db.prepare('INSERT OR IGNORE INTO contacts (account_id, contact_hash, first_seen, last_seen) VALUES (?,?,?,?)'),
    contactTouch: db.prepare('UPDATE contacts SET last_seen = ? WHERE account_id = ? AND contact_hash = ?'),

    processedInsert: db.prepare('INSERT OR IGNORE INTO processed_messages (wa_message_id, account_id, received_at) VALUES (?,?,?)'),
    processedPrune: db.prepare('DELETE FROM processed_messages WHERE received_at < ?'),

    logInsert: db.prepare(`INSERT INTO message_log (account_id, direction, contact_mask, kind, status, error_code, text, created_at)
      VALUES (?,?,?,?,?,?,?,?)`),
    logList: db.prepare(`SELECT id, direction, contact_mask, kind, status, error_code, text, created_at
      FROM message_log WHERE account_id = ? ORDER BY id DESC LIMIT ?`),
    logPrune: db.prepare('DELETE FROM message_log WHERE created_at < ?'),
  };

  return {
    // ── accounts ──
    getAccount: (id) => mapAccount(q.accountById.get(id)),
    getAccountByPhoneNumberId: (pid) => mapAccount(q.accountByPhone.get(pid)),
    listAccounts: () => q.accountsAll.all().map(mapAccount),
    createAccount(a) {
      const now = Date.now();
      q.accountInsert.run(
        a.id, a.label, a.phoneNumberId, a.businessAccountId, a.displayPhoneNumber ?? null, a.accessTokenEnc ?? null,
        toDb(!!a.autoReplyEnabled), toDb(!!a.welcomeEnabled), a.welcomeMessage || '',
        toDb(!!a.defaultReplyEnabled), a.defaultReplyMessage || '', now, now,
      );
      return mapAccount(q.accountById.get(a.id));
    },
    updateAccount(id, patch) {
      const upd = buildUpdate('accounts', ACCOUNT_COLUMNS, id, patch);
      if (upd) db.prepare(upd.sql).run(...upd.params);
      return mapAccount(q.accountById.get(id));
    },
    deleteAccount: (id) => q.accountDelete.run(id).changes > 0,

    // ── keyword rules ──
    listRules: (accountId) => q.rulesAll.all(accountId).map(mapRule),
    listActiveRules: (accountId) => q.rulesActive.all(accountId).map(mapRule),
    getRule: (accountId, ruleId) => mapRule(q.ruleById.get(ruleId, accountId)),
    countRules: (accountId) => Number(q.ruleCount.get(accountId).n),
    createRule(r) {
      const now = Date.now();
      q.ruleInsert.run(r.id, r.accountId, r.keyword, r.matchType, r.replyText, r.priority ?? 0, toDb(r.enabled !== false), now, now);
      return mapRule(q.ruleById.get(r.id, r.accountId));
    },
    updateRule(accountId, ruleId, patch) {
      const upd = buildUpdate('keyword_rules', RULE_COLUMNS, ruleId, patch, { sql: 'account_id = ?', param: accountId });
      if (upd) db.prepare(upd.sql).run(...upd.params);
      return mapRule(q.ruleById.get(ruleId, accountId));
    },
    deleteRule: (accountId, ruleId) => q.ruleDelete.run(ruleId, accountId).changes > 0,

    // ── contacts / dedupe / logs ──
    /** Records a contact and reports whether this is the first time the server has seen it. */
    touchContact(accountId, contactHash) {
      const now = Date.now();
      const inserted = q.contactInsert.run(accountId, contactHash, now, now).changes > 0;
      if (!inserted) q.contactTouch.run(now, accountId, contactHash);
      return { isNew: inserted };
    },
    /** Returns true only the first time a WhatsApp message id is seen (webhooks can be redelivered). */
    markProcessed: (waMessageId, accountId) => q.processedInsert.run(waMessageId, accountId, Date.now()).changes > 0,
    addLog(e) {
      q.logInsert.run(e.accountId, e.direction, e.contactMask, e.kind, e.status, e.errorCode ?? null, e.text ?? null, Date.now());
    },
    listLogs: (accountId, limit) => q.logList.all(accountId, limit).map((r) => ({
      id: Number(r.id), direction: r.direction, contact: r.contact_mask, kind: r.kind,
      status: r.status, errorCode: r.error_code, text: r.text, createdAt: r.created_at,
    })),
    prune(retentionDays) {
      const logs = q.logPrune.run(Date.now() - retentionDays * 86400000).changes;
      const processed = q.processedPrune.run(Date.now() - 7 * 86400000).changes;
      return { logs: Number(logs), processed: Number(processed) };
    },
    ping: () => db.prepare('SELECT 1 AS ok').get().ok === 1,
    close: () => db.close(),
  };
}

module.exports = { openDatabase };
