'use strict';

/** Public shapes returned by the API. Secrets are never included, not even partially. */
function publicAccount(a) {
  return {
    id: a.id,
    label: a.label,
    phoneNumberId: a.phoneNumberId,
    businessAccountId: a.businessAccountId,
    displayPhoneNumber: a.displayPhoneNumber,
    hasAccessToken: !!a.accessTokenEnc,
    autoReplyEnabled: a.autoReplyEnabled,
    welcomeEnabled: a.welcomeEnabled,
    welcomeMessage: a.welcomeMessage,
    defaultReplyEnabled: a.defaultReplyEnabled,
    defaultReplyMessage: a.defaultReplyMessage,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function publicRule(r) {
  return {
    id: r.id,
    keyword: r.keyword,
    matchType: r.matchType,
    replyText: r.replyText,
    priority: r.priority,
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

module.exports = { publicAccount, publicRule };
