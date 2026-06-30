# Telegram operator bot

An optional Telegram bot for **operators** (admins and mods) — not readers.
It does three things:

1. **Notifications** — comment events delivered to a chat as messages, with
   inline **Approve / Spam / Delete / Ban author / Resolve** buttons.
2. **On-the-spot moderation** — tap a button to act without opening the admin
   panel. Every action runs through the same audited path as the dashboard.
3. **Queries + digest** — `/queue`, `/stats`, `/comment <id>`, `/user <id>`,
   and an optional once-daily summary.

The feature is **off** until `TELEGRAM_BOT_TOKEN` is set. With only the token,
outbound notifications work; inbound buttons and commands additionally need
`TELEGRAM_WEBHOOK_SECRET` and a `setWebhook` call.

## 1. Create the bot

In Telegram, talk to [@BotFather](https://t.me/BotFather):

1. `/newbot` → pick a name and a `@username` (the username must end in `bot`).
2. BotFather hands you a **token** like `123456789:AAH...`. Treat it as a
   secret — it can send messages as your bot.
3. (Optional) `/setcommands` and paste:
   ```text
   queue - Pending + reported counts
   stats - Totals and 7-day spam rate
   comment - <id> a comment's status + author
   user - <id> a user's role + status
   ```

## 2. Set the secrets

The token and the webhook secret are **Worker secrets** — never put them in
`wrangler.toml`. The webhook secret is any high-entropy string you choose;
Telegram echoes it back on every inbound update so the Worker can tell a real
delivery from a spoofed one.

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET   # e.g. `openssl rand -hex 32`
```

The bot's `@username` is **not** secret — set it as a plain var in
`wrangler.toml` `[vars]` so the admin page can render a one-tap link:

```toml
TELEGRAM_BOT_USERNAME = "YourGarrulBot"
```

For local `wrangler dev`, the same three names live in `.dev.vars`
(see `.dev.vars.example`).

## 3. Register the webhook (inbound)

Point Telegram at the Worker's top-level `/telegram/webhook` route and pin the
secret header. Run this once (or after the URL changes):

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://comments.example.com/telegram/webhook" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

`secret_token` is what Telegram sends back in the
`X-Telegram-Bot-Api-Secret-Token` header. The route compares it in constant
time and returns **403** on any mismatch or missing header — it's the only
gate on this route (it sits outside `/api/*`, so it has no cookie session or
Origin check).

To verify: `curl -s ".../bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"`.

## 4. Wire up notifications

Notifications reuse the existing webhook system (see [webhooks.md](./webhooks.md)).
Add an endpoint in **`/admin/webhooks`** with the **`telegram`** adapter and put
the **chat id** (not a URL) in the URL field:

- A personal chat: message the bot once, then read your numeric id from
  `getUpdates`, or use a tool like [@userinfobot](https://t.me/userinfobot).
- A channel: `@yourchannel` (the bot must be an admin of it).

The bot token comes from the env secret at send time; only the chat id is
stored. Pick the events you want (`comment.reported`, `comment.posted`,
`comment.spam`, …) — the same per-event filtering, HMAC-less Telegram send,
retry queue, and auto-pause as every other adapter apply.

Each notification carries inline buttons tailored to the event (e.g.
"Not spam" on a spam event, "Resolve reports" on a reported one).

## 5. Link your operator account

A button tap or slash command must map back to a Garrul operator — a stored
link is **identity only**, and the linked user's **current role is re-checked
on every action** (mod for moderate/resolve, admin for ban). Revoking someone's
role disables their buttons immediately, even while the link row persists.

To link:

1. Open **`/admin/telegram`** and click **Generate link code**. The code is a
   one-time token stored in KV with a 10-minute TTL.
2. Send `/start <code>` to the bot (or tap the **Open in Telegram** deep link
   if `TELEGRAM_BOT_USERNAME` is set).
3. The bot confirms and writes the `telegram_links` row.

Unlink any time from the same page. You can also toggle the **daily digest**
there.

## 6. Commands

All read-only; all require a linked operator with at least mod role:

| Command | Shows |
|---|---|
| `/queue` | pending count, open-report count, oldest pending |
| `/stats` | totals + 7-day spam rate |
| `/comment <id>` | a comment's status, author, snippet, open reports |
| `/user <id>` | a user's role, ban status, provider, join age |

The `/cmd@YourGarrulBot` form (used in group chats) is accepted too.

## 7. Daily digest (optional)

Operators who toggle **the daily digest** on `/admin/telegram` get a once-daily
status summary (pending, open reports + most-flagged thread, 7-day spam rate,
oldest pending). It runs from the existing `*/15` cron and self-gates to roughly
once every 24 hours — no separate schedule to configure.

## Security notes

- **Token / chat id / comment bodies are never logged.** The digest and command
  readouts carry counts, slugs, and ages only — no names, emails, or bodies.
- The inbound route is rate-limited per Telegram user id.
- The secret-token check is mandatory and constant-time; an unset
  `TELEGRAM_WEBHOOK_SECRET` rejects all inbound updates (fail closed).
- Actions taken from Telegram write the same audit rows as the dashboard,
  attributed to the linked operator's user id.
