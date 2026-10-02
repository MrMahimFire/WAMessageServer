# WhatsApp Auto-Reply Server

Official **WhatsApp Business Cloud API** ব্যবহার করে অটো-রিপ্লাই সার্ভার (Node.js 22+, Express, SQLite)। QR/session-ভিত্তিক unofficial কোনো পদ্ধতি নেই।

## চালানোর ধাপ
1. `.env.example` দেখে এনভায়রনমেন্ট ভ্যারিয়েবল সেট করুন (`ADMIN_API_KEYS`, `WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `ENCRYPTION_KEY`)।
2. `npm install && npm start` (অথবা Docker: `docker build` করে `/data` এ persistent volume মাউন্ট করুন)।
3. Meta App Dashboard → WhatsApp → Configuration → Webhook:
   - Callback URL: `https://<your-domain>/webhook`
   - Verify token: `WEBHOOK_VERIFY_TOKEN` এর মান
   - `messages` field subscribe করুন।
4. Admin API দিয়ে নম্বর যোগ করুন (নিচে)।

## Authentication
`/api/v1/*` এর সব request-এ লাগবে: `Authorization: Bearer <ADMIN_API_KEY>` (অথবা `X-API-Key`)। Key কখনো URL query-তে পাঠাবেন না।

## Admin API (`/api/v1`)
| Method | Path | কাজ |
|---|---|---|
| GET | `/accounts` | সব নম্বরের তালিকা |
| POST | `/accounts` | নতুন নম্বর যোগ (`label, phoneNumberId, businessAccountId, accessToken`, ঐচ্ছিক config) |
| GET / PATCH / DELETE | `/accounts/:id` | নম্বর দেখা / config বদলানো / মুছে ফেলা |
| PUT | `/accounts/:id/auto-reply` | `{ "enabled": true }` — Auto Reply ON/OFF |
| GET / POST | `/accounts/:id/rules` | Keyword rule তালিকা / নতুন (`keyword, replyText, matchType, priority, enabled`) |
| PATCH / DELETE | `/accounts/:id/rules/:ruleId` | Rule বদলানো / মোছা |
| GET | `/accounts/:id/logs?limit=50` | কার্যকলাপ লগ (নম্বর masked) |
| POST | `/accounts/:id/test-message` | `{ "to": "8801XXXXXXXXX", "text": "..." }` — টোকেন যাচাই |

`matchType`: `exact` · `contains` (ডিফল্ট) · `starts_with`। বেশি `priority` আগে মিলবে।

PATCH-এ পাঠানো যায়: `label, businessAccountId, displayPhoneNumber, accessToken, autoReplyEnabled, welcomeEnabled, welcomeMessage, defaultReplyEnabled, defaultReplyMessage`।

Public endpoints: `GET /health`, `GET|POST /webhook`।

## Reply-এর নিয়ম
- Auto Reply OFF → কোনো রিপ্লাই নয় (নতুন নম্বর ডিফল্টভাবে OFF)।
- নতুন contact (সার্ভার প্রথমবার দেখছে) + Welcome ON → Welcome message।
- Keyword মিললে → সেই reply (Welcome-এর পরেও যায়)।
- কিছু না মিললে → Default reply (শুধু Welcome না পাঠানো হলে)।

## নিরাপত্তা
- Access token AES-256-GCM দিয়ে encrypt হয়ে DB-তে থাকে; কোনো response/log-এ আসে না।
- Webhook `X-Hub-Signature-256` দিয়ে যাচাই হয়; Verify token constant-time তুলনায়।
- Contact-এর নম্বর DB-তে hash করে রাখা হয়; লগে শুধু শেষ ৪ ডিজিট।
- ব্যর্থ লগইন চেষ্টায় IP lock-out ও rate limiting আছে।
