# Notifications

Garrul has two audiences to notify and they want different things: **readers**
want to know when the conversation they joined moves, and **you** want to know
when something needs moderating. Different channels serve them.

The short version: both are **built-in email** — no webhook, no external
pipeline, no queue to run. Webhooks and the Telegram bot are there if you want
the alerts somewhere other than an inbox.

## Pick a channel

| Channel | Reaches | Fires when | To turn on |
| --- | --- | --- | --- |
| **Reply notifications** (email) | readers who opted in on your site | a new comment is approved on a thread they subscribed to | a Resend API key, a verified sender address, and the cron that already ships in `wrangler.example.toml` |
| **Moderator email** | you, at `ADMIN_EMAILS` (or a shared alias) | a comment lands in the moderation queue, or a reader reports one | the same Resend setup, plus one switch in *Settings → Moderation* |
| **Webhook out** | any HTTPS endpoint you control — including Slack, Discord and Telegram adapters | every comment event: `comment.posted`, `.edited`, `.deleted`, `.approved`, `.spam`, `.reported` | a URL and a shared secret in the admin UI — see [`webhooks.md`](webhooks.md) |
| **Telegram operator bot** | you, on your phone, with approve/spam/delete buttons inline | a comment needs moderation; plus `/queue`, `/stats` on demand | a bot token and a webhook secret — see [`telegram.md`](telegram.md) |

None of these are mutually exclusive, and none of them are required — an
instance with no email configured and no webhook set still works; it just
doesn't tell anybody anything.

## Reply notifications by email

### What a reader does

1. Ticks **"Email me about new comments"** in the composer, or presses the
   🔔 in the thread toolbar. A reader whose session carries an address
   doesn't see a field, because it's already known; everyone else types one
   next to the checkbox. ("Signed in" isn't the test — X/Twitter gives us no
   address, so those readers get the field too.)
2. Gets a confirmation email and clicks the link
   (`GET /api/v1/subscribe/confirm/:token`). This is real double-opt-in:
   nothing is delivered to an unconfirmed address.
   **Exception:** a signed-in reader whose OAuth provider verified their
   address (GitHub, Google) is confirmed on the spot — the provider already
   proved inbox control, so no confirmation email is sent at all.
3. Receives an email when new comments land, with an unsubscribe link in
   every one.

### How a reader gets out

Four ways, no account required for the first three:

- **The Unsubscribe button in Gmail or Apple Mail.** Digests carry RFC 8058
  `List-Unsubscribe` headers, so the mail client offers its own button next
  to the sender name. One press, no page to visit. Sending these headers
  also improves deliverability — bulk mail without them is filtered harder.
- **The link at the bottom of every digest.** Two steps on purpose: the link
  only renders a "Yes, unsubscribe me" page, and the button behind it does
  the work. A mail client that pre-fetches links can't silently unsubscribe
  someone.
- **That same page**, which also lists every other thread the address
  follows, with a per-row unsubscribe and an unsubscribe-from-all — for the
  reader who followed twenty threads and doesn't want to find twenty emails.
- **The widget**, for a reader signed in with a provider-verified address —
  *any* of the five, not only the two that skip confirmation above:
  the 🔔 becomes a two-way toggle (🔕 while subscribed, with a distinct
  "waiting for you to confirm" state), and a **Manage subscriptions**
  disclosure beside it lists and cancels every thread that address follows.

The widget controls appear *only* for a session carrying a verified address.
For anyone else the bell stays an action rather than a state toggle, and
deliberately so: `POST /api/v1/subscribe` answers the same way whether or
not an address is already subscribed, so nobody can use it to find out which
addresses follow which posts. Showing the state would mean answering exactly
that question.

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

## Moderator email

The counterpart to the above: readers hear when a comment is **approved**,
you hear when one **isn't**. The two are exact inverses, so a comment never
notifies both audiences.

### What triggers one

- A comment lands in the moderation queue instead of publishing — held by the
  anti-spam verdict, first-comment moderation, or `moderation_mode`.
- A reader files the **first** report on a comment. Later reports on the same
  comment don't re-mail you; a second email about something you've already been
  told about is exactly the noise that gets moderator mail filtered away.

Both reasons can be live for the same comment, and one digest carries both,
labelled.

### Turning it on

Off by default, including on upgrade — turning on outbound mail for an existing
install without being asked would spend your Resend quota and your sending
domain's reputation.

1. Configure email exactly as above (`EMAIL_PROVIDER`, `EMAIL_FROM`,
   `RESEND_API_KEY`, `PUBLIC_BASE_URL`). Without it this is a silent no-op —
   nothing errors, nothing queues.
2. Flip **Email me about the queue** in *Settings → Moderation*, or set
   `MODERATOR_EMAIL_ENABLED = "true"` in `wrangler.toml`. The setting wins over
   the env var, so you can silence it mid-incident without a deploy.

Recipients default to `ADMIN_EMAILS` — already exactly the set of people who can
act on what the mail is about. Set `MODERATOR_NOTIFY_EMAILS` (comma-separated)
only if the alerts belong somewhere else, such as a shared `moderation@` alias.

### The mechanism

Same shape as the reader digest, and the same cron:

- **5-minute debounce**, so a spam flood is one email listing 25 comments, not
  25 emails. Queue depth changes the digest's length, never the number of sends.
- **Up to 25 comments per tick.** The overflow isn't lost — it goes out on the
  next tick.
- Anything you **already handled** inside that window is dropped silently. If
  you approved the comment before the tick fired, no email mentions it.
- **Failures stay pending** and the next tick retries.
- Comment bodies are re-sanitized with `sanitizeForEmail`, same as the reader
  digest.
- **English only**, deliberately — the same call as the admin UI and the
  Telegram bot.

Its send budget is separate from the confirmation one (`moderator:burst`, 10/60 s;
`moderator:daily`, 500/24 h — fixed, not settable, and counted **per digest, not
per recipient**, so adding a moderator to the list never brings the cap closer).
A tick that can't reserve mails nobody and leaves its rows queued for the next
one: the fan-out is all-or-nothing, so a cap can never mail half your team and
mark the batch handled. That separation is the point:
a spam flood filling your queue can't spend the budget that lets new subscribers
confirm, and an attack on `/api/v1/subscribe` can't silence the flood alert.
A tripped cap logs `moderator email budget exhausted` in `wrangler tail`.

## When email isn't arriving

Start with [`troubleshooting.md`](troubleshooting.md). The usual causes, in
order: the sender domain isn't verified in Resend; `PUBLIC_BASE_URL` still
points at the example domain, so confirm links 404; or the `[triggers]` block
was removed and nothing is flushing either queue.

If reader digests arrive but moderator mail doesn't, the switch is the thing to
check — it's off until you turn it on, and it's off *silently*.
