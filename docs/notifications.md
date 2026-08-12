# Notifications

Garrul has two audiences to notify and they want different things: **readers**
want to know when the conversation they joined moves, and **you** want to know
when something needs moderating. Different channels serve them.

The short version: reader reply notifications are **built-in email** — no
webhook, no external pipeline, no queue to run. Operator alerts go out over
webhooks or the Telegram bot.

## Pick a channel

| Channel | Reaches | Fires when | To turn on |
| --- | --- | --- | --- |
| **Reply notifications** (email) | readers who opted in on your site | a new comment is approved on a thread they subscribed to | a Resend API key, a verified sender address, and the cron that already ships in `wrangler.example.toml` |
| **Webhook out** | any HTTPS endpoint you control — including Slack, Discord and Telegram adapters | every comment event: `comment.posted`, `.edited`, `.deleted`, `.approved`, `.spam`, `.reported` | a URL and a shared secret in the admin UI — see [`webhooks.md`](webhooks.md) |
| **Telegram operator bot** | you, on your phone, with approve/spam/delete buttons inline | a comment needs moderation; plus `/queue`, `/stats` on demand | a bot token and a webhook secret — see [`telegram.md`](telegram.md) |

**Moderator email is not a channel yet.** If you want "something is in the
queue" in your inbox rather than in a chat app, today that means pointing a
webhook at an email-capable endpoint, or using the Telegram bot. Native
moderator email is planned.

None of these are mutually exclusive, and none of them are required — an
instance with no email configured and no webhook set still works; it just
doesn't tell anybody anything.

## Reply notifications by email

### What a reader does

1. Ticks **"Email me about new comments"** in the composer. An anonymous
   reader types an address next to the checkbox; a signed-in reader doesn't
   see a field, because their session already carries one.
2. Gets a confirmation email and clicks the link
   (`GET /api/v1/subscribe/confirm/:token`). This is real double-opt-in:
   nothing is delivered to an unconfirmed address.
   **Exception:** a signed-in reader whose OAuth provider verified their
   address (GitHub, Google) is confirmed on the spot — the provider already
   proved inbox control, so no confirmation email is sent at all.
3. Receives an email when new comments land, with an unsubscribe link in
   every one.

Unsubscribing is two steps on purpose: the link in the email only renders a
"Yes, unsubscribe me" page, and the button behind it does the work. A mail
client that pre-fetches links can't silently unsubscribe someone.

### What gets delivered

Subscriptions are **thread-scoped** — one row per `(post_slug, email)`. A
subscriber hears about every new comment on that post, not only direct
replies to their own comment. The widget checkbox says exactly that; per-reply
scoping would be a different feature.

Only **approved** comments notify. A comment held in the moderation queue, or
caught as spam, notifies nobody until you approve it — approval is what
enqueues the notification.

### The mechanism

Nothing sends inline on the request path. Posting a comment writes rows to a
D1 `notifications` queue and returns; the cron flushes them:

- **Cron every 15 minutes** — ships in `wrangler.example.toml`'s `[triggers]`
  block and auto-registers on deploy.
- **5-minute debounce** — a notification isn't picked up until it's that old,
  so a burst of replies coalesces into one email per subscriber instead of N.
  That's what the cron buys you; it is not a "daily roundup" — the send is
  caused by the comment.
- **Up to 50 digests per tick**, so one busy post can't monopolize a run.
- **Failures stay pending.** A send that fails leaves its rows unmarked and the
  next tick retries. A slow or failing Resend never delays or fails a reader's
  comment.
- Comment bodies are **re-sanitized for email** (`sanitizeForEmail`) rather than
  reusing the stored HTML — mail clients have a different threat model than
  browsers.
- Each subscriber's email is rendered in **their own locale**, taken from the
  subscription row, falling back to English.

### Turning it on

Three things, then deploy:

1. `EMAIL_PROVIDER = "resend"` in `wrangler.toml`.
2. `EMAIL_FROM` set to a sender on a Resend-verified domain.
3. `wrangler secret put RESEND_API_KEY`.

`PUBLIC_BASE_URL` must also be correct — it builds the confirm, unsubscribe and
permalink URLs in the mail.

**If you skip this, nothing breaks.** With `EMAIL_PROVIDER` or
`RESEND_API_KEY` unset, `sendEmail` returns `false`, the caller logs a warning,
and the request continues. Readers still comment; they just can't subscribe
usefully. Remove the `[triggers]` block too if you'd rather not register the
cron at all.

### Limits worth knowing

`POST /api/v1/subscribe` is the only endpoint where an unauthenticated caller
can spend your email quota, so it has a hard global ceiling counted in D1:

| Budget | Default | Window | Setting |
| --- | --- | --- | --- |
| `confirm:burst` | 20 sends | 60 s | `CONFIRM_SEND_BURST_MAX` |
| `confirm:daily` | 200 sends | 24 h | `CONFIRM_SEND_DAILY_MAX` |

Reply notifications themselves are **not** counted against it — they go to
already-confirmed addresses that no attacker can enqueue for. Both caps are
settable at runtime from *Settings → Moderation*. Full write-up, including what
you see in `wrangler tail` when a cap trips:
[`../AGENTS-OPERATE.md`](../AGENTS-OPERATE.md) §9, threat model in
[`ANTISPAM.md`](ANTISPAM.md).

Resend's free tier is 100 emails/day, which most instances will hit before any
Garrul limit.

### When it isn't working

Start with [`troubleshooting.md`](troubleshooting.md). The usual causes, in
order: the sender domain isn't verified in Resend; `PUBLIC_BASE_URL` still
points at the example domain, so confirm links 404; or the `[triggers]` block
was removed and nothing is flushing the queue.
