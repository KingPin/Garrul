# Webhooks

Outbound HTTP notifications when comments change state. Configure
endpoints in `/admin/webhooks`.

## Payload (v1)

```json
{
  "event": "comment.posted",
  "comment_id": "01HXX0000000000000000",
  "post_slug": "blog/hello-world",
  "user_id":   "01HXY0000000000000000",
  "ts": 1700000000000
}
```

Events:

- `comment.posted` — a new comment was accepted (may still be `pending`
  if the spam pipeline holds it for review)
- `comment.edited` — author edited inside the edit window
- `comment.deleted` — admin/mod deleted (soft-delete)
- `comment.approved` — admin/mod approved a pending/spam comment
- `comment.spam` — admin/mod marked spam

Headers:

- `Content-Type: application/json`
- `User-Agent: Garrul-Webhook/2.0`
- `X-Garrul-Signature: t=<ms_epoch>,v1=<hex_sha256>` *(only if the
  endpoint has an HMAC secret)*

## Verifying the signature

Required for any endpoint that has a secret configured. Reject every
unsigned delivery on an endpoint you configured *with* a secret —
treating unsigned requests as valid defeats the point of having one.

The signed payload is `<ts>.<raw_body>` — the literal request body
prefixed by the timestamp from the header. **Hash the raw bytes, not a
re-serialized JSON object** — re-serializing reorders keys.

```js
// Node 18+ / any standard HMAC library
import crypto from "node:crypto";

const TOLERANCE_MS = 5 * 60 * 1000;

function verify(secret, rawBody, header) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map(p => p.split("=", 2)),
  );
  const ts = Number(parts.t);
  const sig = parts.v1;
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() - ts) > TOLERANCE_MS) return false;
  const want = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");
  // Constant-time compare — never use === on the hex strings.
  return (
    want.length === sig.length &&
    crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))
  );
}
```

The tolerance defends against replays of an old delivery. Five minutes
matches the sender's default — anything inside that window with a valid
signature is accepted.

## Retries and auto-disable

Failed deliveries (network error or non-2xx response) are retried via
an exponential schedule:

| Attempt | Delay from previous |
|--------:|---------------------|
| 1       | +1 minute           |
| 2       | +5 minutes          |
| 3       | +30 minutes         |
| 4       | +2 hours            |
| 5       | +6 hours            |

After 5 retries (≈9h total) the delivery is given up and the
endpoint's failure counter increments. After 10 consecutive give-ups
the endpoint is auto-paused — the admin UI shows the `auto-paused`
note. Re-enabling the endpoint clears the counter and pause marker.

Each retry signs with a *fresh* timestamp so the receiver's tolerance
check still passes hours after the original event.

## Adapter selection

The default `generic` adapter sends the v1 payload above. `slack` and
`discord` adapters reshape the body for those platforms — set this on
the endpoint when the target URL is a Slack or Discord incoming
webhook. Adapter changes do not require receiver changes.

The `discord` adapter sends a single rich **embed** (`{"embeds":[…]}`):
the commenter's name as the embed author, the post title as a link to the
page, the comment snippet as the (markdown-rendering) description, an
event-colored accent (new = blurple, approved = green, spam/deleted =
red, edited = grey), and a **Links** field with *🔍 Open in admin* and
*🌐 View page*. The `slack` adapter sends the same information as text,
with the title and the two links rendered using Slack's `<url|label>`
syntax.

Both link to `…/admin/comments/<id>` (the moderation detail page) and to
the post's public URL. These links require **`PUBLIC_BASE_URL`** to be
set — if it is unset, the notification still sends but the admin link is
omitted. The page link additionally requires the post to have a stored
`url` (published by the embed widget's `data-url` on first comment), and
that URL is scheme-validated (`http`/`https` only) before it is shown.

Safety notes specific to the rich adapters: comment bodies can't ping a
channel (`@everyone`/role mentions are neutralized), and the Discord embed
description escapes `[`/`]` so a comment body like `[click](https://evil)`
renders as literal text rather than a clickable masked link.

## Legacy `WEBHOOK_URL`

Operators upgrading from the original single-`WEBHOOK_URL` setup used one
env var with no signing and no retries. That still works: when set with no
table rows, Garrul synthesizes an unsigned, retry-less endpoint at
dispatch time. The admin page flags this with a banner so you know to
migrate. Add a real endpoint (with a secret) and unset the env var to
gain signing + retries.
