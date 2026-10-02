'use strict';

function normalize(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Rules must already be ordered by priority (the database does this). First match wins. */
function matchRule(rules, text) {
  const t = normalize(text);
  if (!t) return null;
  for (const rule of rules) {
    const kw = normalize(rule.keyword);
    if (!kw) continue;
    if (rule.matchType === 'exact' && t === kw) return rule;
    if (rule.matchType === 'contains' && t.includes(kw)) return rule;
    if (rule.matchType === 'starts_with' && t.startsWith(kw)) return rule;
  }
  return null;
}

/**
 * Decides which messages to send for one incoming message.
 *  - Auto reply OFF            → nothing.
 *  - New contact + welcome ON  → welcome message.
 *  - Keyword rule matches      → that rule's reply (also sent after the welcome, if any).
 *  - No rule matched           → default reply, unless the welcome was just sent.
 */
function decideReplies({ account, rules, text, isNewContact }) {
  if (!account.autoReplyEnabled) return [];

  const replies = [];
  let welcomed = false;

  if (isNewContact && account.welcomeEnabled && account.welcomeMessage) {
    replies.push({ kind: 'welcome', text: account.welcomeMessage });
    welcomed = true;
  }

  const rule = matchRule(rules, text);
  if (rule) {
    replies.push({ kind: 'keyword', text: rule.replyText });
  } else if (!welcomed && account.defaultReplyEnabled && account.defaultReplyMessage) {
    replies.push({ kind: 'default', text: account.defaultReplyMessage });
  }
  return replies;
}

module.exports = { normalize, matchRule, decideReplies };
