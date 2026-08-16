# Anti-spam

Garrul defends against spam in layers. The base protections below are **always on** and ship with every instance; the optional layers are **off by default** — turn on what you need.

## What's always on

These don't need configuration; they ship with every Garrul instance:

- **Turnstile** — Cloudflare's CAPTCHA-alternative. Required for anonymous POSTs whenever `TURNSTILE_SITE_KEY` is set. See [Turnstile mount timing](#turnstile-mount-timing) for when it loads and what its four visitor-facing messages mean.
- **Rate-limit** — sliding window on the edge Cache API (not KV), keyed on the hashed client IP for anonymous callers and on the user id for signed-in ones. 1 anonymous comment per 10s and 5 per 10 min by default; signed-in authors get 3 per 10s and 60 per 10 min. Every caller is also held under one shared per-identity envelope across all endpoints. An optional [Durable Object backend](#the-durable-object-backend-opt-in) makes the counting atomic and global. **Read [Rate-limit accuracy](#rate-limit-accuracy-known-limitations) before you rely on these numbers as a hard ceiling** — they are not one.
- **Markdown sanitizer** — strict allowlist; only `https:`/`http:`/`mailto:` links survive, raw HTML and `<img>` are dropped, every link gets `rel="nofollow ugc noopener" target="_blank"`.
- **Field honeypot** — a hidden `website` input in the embed form. If a bot fills it, the POST is rejected with HTTP 400.
- **Confirmation-email ceiling** — a global, atomic cap on outbound subscription confirmation mail, counted in D1. Unlike the rate limit this *is* a hard ceiling, and it is the only control on the subscribe endpoint that an address-cycling concurrent burst cannot get past. See [The confirmation-email ceiling](#the-confirmation-email-ceiling).

## Turnstile mount timing

Turnstile does not load with the page. The widget mounts its anti-spam iframe — `/embed/turnstile-frame`, which then pulls Cloudflare's `api.js` and its challenge platform — when the visitor **first focuses the comment box**. `api.js` and its dependencies are roughly twice the size of the whole comment widget, and almost nobody who loads a page comments, so a reader who never touches the composer never downloads any of it.

Consequences worth knowing before you debug a report:

- **In DevTools, expect zero `turnstile` requests on load.** They appear on first focus of the composer (the textarea, the name field, anything in the form except the submit button). This is correct behavior, not a broken widget. Reply forms mount on open, since opening one is already the intent signal.
- **A visitor can submit before a token exists** — clicking Post without focusing anything is reachable, because a restored draft pre-fills the box silently. The widget shows `Checking…` on the button and waits up to 9 seconds.

### The four messages, and what each one means

When that wait doesn't produce a token, the visitor sees one of four things. They are deliberately different, because the operator action differs:

| Message | Meaning | Post button | What to check |
| --- | --- | --- | --- |
| "Complete the anti-spam check above, then post again." | Turnstile is working and something has to happen before it will mint a token — usually that the visitor clicks the checkbox. | Re-enabled | Nothing. Expected in managed mode. Deferring the mount makes this somewhat more likely, since Turnstile has less passive observation time before it has to mint a token. This message is also used when a challenge timed out and reset itself, where there may be nothing visible to click; Turnstile re-runs on its own, so posting again a moment later works. |
| "The anti-spam check didn't load. Check your connection or reload the page." | The iframe never reported in at all. | Re-enabled | Host CSP missing `frame-src` for the Worker origin, the host site missing from `ALLOWED_ORIGINS`, or a blocked/failed frame document. Also expected briefly (up to 5 minutes) right after an upgrade, since the frame document is cached with `max-age=300` and an older copy doesn't send the newer status messages. |
| "The anti-spam check hit a snag and is retrying. Post again in a moment." | Turnstile reported an error it marks **retryable** and the widget has reset the challenge. | Re-enabled | Nothing, on an isolated report. If visitors see this routinely, check `challenges.cloudflare.com` reachability — a flaky path produces the same code as a one-off blip. |
| "Anti-spam check failed to load. Reload the page; …" | The frame *reported* an error that a retry cannot fix — either a non-retryable Turnstile code, or a code-less error post (which means the frame itself never got as far as running the challenge). Distinct from the row above, where the frame stayed silent and the widget only inferred a problem when the wait timed out. | **Stays disabled** | `https://challenges.cloudflare.com` reachability, and that `TURNSTILE_SITE_KEY` matches the site key configured in Cloudflare. |

Only the fourth message disables the composer, and it is sticky: nothing later re-enables the button, and only a page reload clears it. The other three are recoverable and always hand the button back.

#### Which errors retry, and which latch

The widget used to latch on **any** error Turnstile reported. That was blunt: `error-callback` also fires for transient conditions Cloudflare's own guidance says to reset and retry, and those latched identically to a real outage — so a visitor who hit a blip had to reload the page to comment.

The frame now forwards Turnstile's error code to the widget, which spends a **one-shot retry budget** on the codes Cloudflare says are retryable:

- **Retries once** — every code marked `Retry: Yes` in [Cloudflare's client-side error table](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/): `300***` and `600***` (generic challenge failure), `110600` (challenge timed out), `110620` (interaction timed out) and `200500` (the inner Turnstile iframe failed to load). The widget resets the challenge and stays usable. If nobody was mid-submit when the error landed, this is completely silent: no message, no visible change.
- **Latches immediately** — every code marked `Retry: No`: `110100`/`110110` (invalid or unknown sitekey), `110200` (domain not authorized), `200100` (clock or cache problem), `400020`/`400070` (invalid or disabled sitekey). These fail identically forever, so retrying them just wastes the visitor's time before showing the same message. Anything not in the table at all latches too — an unrecognized code is treated as permanent so a future Turnstile code family can't open a silent retry loop.
- **Latches immediately** — a code-less error. Three of the four things that report an error mean the frame never came up (`api.js` absent, `render()` throwing, the 8-second load watchdog), and for those "reload the page" is genuinely the right advice.
- **Latches on the second error**, whatever it is. After a reset produced the same failure again, a blip is indistinguishable from an outage, and a visitor watching a retry loop is worse served than one told to reload.

The budget is one reset for the lifetime of the composer; it is not refilled by a successful post.

The widget also renders the challenge with `retry: "never"`, turning off Turnstile's own auto-retry. That default silently re-runs a failed challenge every 8 seconds, which would make the budget above meaningless — one outage lasting past a single interval fires the error callback twice, spending the retry on the first and latching on the second while Turnstile was still recovering. With it off, the reset the widget asks for is the only thing that re-arms a failed challenge, so the behavior described here is the behavior you get. Token *expiry* is unaffected: `refresh-expired` is still `auto`, so an expiring token re-challenges on its own and never reaches this path.

**During the first five minutes after an upgrade, expect the old behavior.** The frame document is cached with `max-age=300`, and an older copy sends no error code — which the widget treats as "the frame never came up" and latches, exactly as it did before. That is the deliberate fail-safe direction: version skew degrades to latching, never to a blind retry loop.

None of this is a security relaxation. The client-side latch was never the control — `POST /api/v1/comments` rejects a missing or invalid `turnstile_token` unconditionally, server-side, so the worst a retry can produce is one more failed submit against an already rate-limited endpoint.

## Optional layers

All four heuristics + the classifier adapter flip a flagged comment to `status='pending'` so it lands in the admin queue at `/admin/queue?status=pending`. **Nothing is ever silently dropped.** You decide whether to approve.

**The four heuristics are runtime-tunable.** Each one has an env var below that sets the deploy-time default, but you can retune all four from **Admin → Settings → Moderation** without a redeploy — which is how you want to work while watching the queue. An admin save writes a `settings` row that overrides the env var (precedence is DB > env > built-in default); "Reset to defaults" clears the overrides and hands control back to `wrangler.toml`. The classifier in §5 stays deploy-time: it needs credentials, and a dropdown offering a provider the deploy can't reach is worse than an env var.

### 1. Honeypot timing (`SPAM_HONEYPOT_MIN_MS`)

Bots typically POST immediately. Humans take seconds. The widget asks the server for a signed timestamp when the form loads; the server checks that enough wall-clock time passed before accepting.

```toml
SPAM_HONEYPOT_MIN_MS = "1500"   # flag if submit happens within 1.5s of form load
```

`0` (or unset) turns the check off. Tunable at runtime as **Minimum fill time (ms)**.

Also requires the HMAC secret:

```
wrangler secret put SPAM_FORM_TS_SECRET
```

Generate a strong random value (`openssl rand -hex 32`) and paste when prompted. Without it the timestamp is unsigned and therefore forgeable, so the check is skipped entirely — the Settings page says so inline if you enable the dial without the secret in place.

### 2. Link-count threshold (`SPAM_LINK_THRESHOLD`)

Counts `https?://` and `mailto:` occurrences in the comment body. Above the threshold, flag to pending.

```toml
SPAM_LINK_THRESHOLD = "3"   # flag any comment with more than 3 links
```

`-1` (or unset) turns the check off; `0` flags any comment containing a link at all. Tunable at runtime as **Link threshold**.

Strong signal against link-farm spam. Some legit comments (e.g. linking 4-5 papers in a technical thread) will get flagged — that's why this routes to the queue, not to the bin.

### 3. First-comment moderation (`SPAM_FIRST_COMMENT_MODERATE`)

Every new commenter's first-ever comment goes to `pending` until you approve once. Subsequent comments from the same author (same hashed IP for anonymous, same OAuth identity for signed-in users) post normally. Admins skip this check.

```toml
SPAM_FIRST_COMMENT_MODERATE = "true"
```

Tunable at runtime as **Hold every author's first comment**.

Highest precision of the four heuristics. Cost: you have to log in and approve. Use on low-traffic blogs; skip on busy ones.

### 4. Muted words (`SPAM_BLOCKLIST`)

An operator-maintained list of terms. One per line; a hit routes the comment to the queue.

```toml
SPAM_BLOCKLIST = """
viagra
*casino*
t.me/*
"""
```

Empty (or unset) turns the check off. Maintained at runtime as **Muted words** — the env var is only the default a fresh deploy starts with, and most instances will never set it, because this is the one heuristic you tune by reading your own queue.

**The grammar is three rules, and it is not a regex.**

| Term | Matches | Does not match |
| --- | --- | --- |
| `viagra` | "buy viagra now", "Viagra." | "viagraceous" |
| `*casino*` | "casino", "megacasinos" | — |
| `t.me/*` | "t.me/spamchannel" | "at.me/x" |

A bare term is anchored to word boundaries, which is what keeps `ass` from flagging "class" — the [Scunthorpe problem](https://en.wikipedia.org/wiki/Scunthorpe_problem) is the default failure mode of a naive blocklist, so wildcards are opt-in per term rather than the other way round. `*` is the only metacharacter: `.` and `(` are literal text, so a term copied out of a spam comment works as typed.

Matching is case-insensitive and folds Unicode compatibility forms, so fullwidth `ｖｉａｇｒａ` is caught by `viagra`, as are terms padded with zero-width joiners and soft hyphens. It does **not** strip accents and does **not** decode leetspeak: `v1agra` needs its own line. Lines starting with `#` are comments.

Each term is checked against the comment body, the author's display name and the page URL — author name matters, because a spammer whose comment is clean can still be posting as "Best Casino Bonus". The first hit wins, and the matched term is recorded in the stored verdict and the log, never in the API response, so nobody can bisect your list by watching which posts get held.

Limits: 200 terms, 100 characters and 4 wildcards each, and only the first 10,000 characters of each field are scanned. A term over those limits is skipped and the rest of the list still applies. The matcher is a plain string walk, not a compiled regex — a blocklist is operator-supplied input, and no arrangement of terms can make it backtrack.

### 5. Content classifier (`SPAM_PROVIDER`)

Pluggable third-party content classification. Pick one of:

#### `akismet`

```toml
SPAM_PROVIDER = "akismet"
```

```
wrangler secret put AKISMET_API_KEY     # your Akismet API key
wrangler secret put AKISMET_SITE_URL    # public site URL, e.g. https://yourblog.example.com
```

**Privacy tradeoff.** Akismet receives the comment body, the author's display name, and the post URL. Garrul deliberately does **not** forward the raw client IP (a constant placeholder is sent instead) or the OAuth-user email address. This trims accuracy a little, but keeps Garrul's privacy posture intact.

If you turn this on, **update your privacy policy** (template at [`docs/privacy-policy.template.md`](./privacy-policy.template.md)) to disclose that comment content is sent to Automattic. Akismet also requires a commercial license for paid sites — check their terms.

#### `workers-ai`

```toml
SPAM_PROVIDER = "workers-ai"
```

Add an AI binding to `wrangler.toml`:

```toml
[ai]
binding = "AI"
```

**Privacy posture.** Inference runs on Cloudflare's edge via your AI binding — no third-party API call leaves CF infrastructure. The classifier prompt is Llama-3.1-8b-Instruct asking SPAM/HAM. Verdicts are cached in the `RATE_LIMITS` KV namespace for 6 hours keyed on a SHA-256 hash of the body, so identical resubmissions don't re-bill.

Tradeoff vs. Akismet: slower per check, generally pricier per inference, less spam-specific signal, but no third-party data egress. Good fit if your audience cares about that, or if you don't want to manage another vendor.

### Combining

Layers stack. With everything on, a comment is flagged if **any** signal trips. The classifier is only called when no heuristic has already flagged (saves cost/latency).

## Rate-limit accuracy (known limitations)

The rate limiter is a **cost-raiser, not a hard ceiling.** Treat the configured numbers as the rate a normal client sees, not the maximum a determined one can achieve. Two things loosen it, both inherent to running the counters on the edge Cache API — which is the default, and the only backend unless you opt into [the Durable Object](#the-durable-object-backend-opt-in):

**1. Counters are per-datacenter.** The Cache API is colo-local, so each Cloudflare datacenter keeps its own copy of a bucket. An attacker whose traffic spreads across colos gets roughly the configured limit *per colo* they reach.

**2. Concurrent requests from one identity are undercounted.** Reading a bucket, deciding, and writing it back is not atomic, and the write replaces the entry rather than appending to it. So N requests held in flight at once all read the same pre-state, all pass the gate, and all write back a bucket grown by exactly one entry — the N-1 losers leave no trace. The effect is a sustained multiplier, not a one-off burst: a client keeping N requests in flight holds roughly N× the configured rate for as long as it likes. The shared envelope races the same way, so it multiplies rather than backstopping.

**Why this is the default rather than fixed everywhere.** The Cache API has no compare-and-swap, so #2 cannot be closed on this backend at all — closing it needs the [Durable Object backend](#the-durable-object-backend-opt-in), which is opt-in because it adds a Cloudflare resource and a migration to your deploy. On the default backend it is still not the front line, because the limiter is deliberately not the only control on any endpoint that accepts an unauthenticated caller:

| Endpoint | Second, non-racy control |
| --- | --- |
| Anonymous comment POST | Turnstile — a fresh single-use token per comment |
| Report | `UNIQUE(comment_id, reporter_ip_hash)` — one report per comment per network, full stop |
| Vote / reaction / page vote | Idempotent toggle on a unique row — repeats flip a row, they don't accumulate |
| Subscribe | A [global confirmation-email ceiling](#the-confirmation-email-ceiling), counted atomically in D1. `PENDING_PER_EMAIL_CAP` (5 unconfirmed rows per address) is also non-racy but binds *per address*, so it alone does not stop an attacker cycling addresses |

**What the race actually buys an attacker.** Every control in that table is unaffected by it, so what #2 loosens is a *rate*, not an action — it cannot buy a second report on the same comment, or a double-counted vote.

On the IP-keyed buckets it is the cheapest bypass currently available. It used not to be: while Garrul hashed the full IPv6 address, one household supplied 2^64 distinct identities and per-IP limiting was unenforceable over IPv6 no matter what the race did. IP hashing now normalizes IPv6 to its /64, so a household is one identity — which closed the larger hole and left this one as the front edge. On the user-id-keyed buckets (signed-in comment POST, edit, delete) and the Telegram route the race is the *only* bypass, and those cost an attacker a real account, which you can ban.

**What to do if this matters for your instance.** Two options, and they are not alternatives — under active attack, use both:

1. **Put Cloudflare WAF rate-limiting rules in front of the Worker.** They run before your code, count accurately, and can key on things Garrul can't see. This is the real ceiling.
2. **Enable the Durable Object backend below.** It closes #1 and #2 inside Garrul, which is what you want for the buckets WAF can't express — the per-user-id ones especially.

Garrul's limiter is the floor that ships in the box, not the ceiling you should rely on under active attack.

## The confirmation-email ceiling

Subscribe is the one unauthenticated endpoint where a loosened *rate* also spends **your money and your sending reputation**: every accepted request sends one confirmation email through Resend. The controls above don't bound that. `PENDING_PER_EMAIL_CAP` is atomic but keyed on the address, so `a@x.com` / `b@x.com` / `c@x.com` each get their own budget; the limiter is IP-keyed and, on the default backend, races. So Garrul counts outbound confirmation mail directly, against a hard ceiling:

| Budget | Cap | Window |
| --- | --- | --- |
| `confirm:burst` | 20 sends | 60 s |
| `confirm:daily` | 200 sends | 24 h |

Both must grant for mail to go out. The short window kills the concurrency burst the racy limiter allows; the long one bounds total spend and bounce-reputation damage over a day. The caps are far above any plausible organic signup rate for a self-hosted blog — the intent is that only abuse ever reaches them.

**Why this one isn't racy.** The counters live in D1 (`email_send_budget`, migration `0018`), not the Cache API, and the whole decision is a single `UPDATE` that carries the cap in its own `WHERE` clause. One SQL statement is indivisible, so check-and-increment cannot be interleaved: concurrent requests are counted one at a time and the losers change zero rows and are told so. This is exactly the compare-and-swap the Cache API doesn't have, which is why #2 above can't be closed there but can be closed here — **with no opt-in resource and no Durable Object.** A single counter row also means the cost is O(1) no matter the traffic; a windowed `COUNT(*)` over `subscriptions` would get *more* expensive precisely under attack, since D1 bills rows read.

A reader who hits the ceiling gets a `429` with `"reason": "send_budget_exhausted"`, and nothing is written to `subscriptions` — no pending row is created that nobody can confirm. Exhaustion is logged at `warn` with the scope and cap, so `wrangler tail` tells you when it trips.

It counts *sends*, not attempts: if Resend rejects the call or the API key is missing, the slot is handed straight back. An install with `EMAIL_FROM` set but `RESEND_API_KEY` unset therefore keeps accepting subscribers instead of burning its daily ceiling on mail that never left.

**What it does not stop.**

- **It is global, not per-identity.** That is deliberate — every per-identity key this endpoint has is either racy (the limiter) or attacker-controlled (`email` is arbitrary; `post_slug` is never validated against `posts`). A global ceiling is the one bound none of those bypasses reach. The cost is real: an attacker who spends a window denies **new** subscriptions until it rolls. Existing confirmed subscribers are untouched — only confirmation mail passes through here, so reply notifications and digests keep flowing, and comments themselves are unaffected. Bounded mail plus a temporary signup outage is a better failure than unbounded billable mail plus a sending domain accruing complaints.
- **The window is fixed, not sliding.** A burst straddling a window boundary can land up to ~2× the cap in quick succession (`max` at the end of one window, `max` at the start of the next). Same trade-off as the rate limiter's buckets. It bounds the sustained rate, which is what matters for a Resend quota.
- **It fails open.** If the migration hasn't landed or D1 errors, the ceiling counts nothing rather than refusing every subscription. Same posture as the rate limiter. Run `npm run migrate` after upgrading.
- **It doesn't stop junk *rows*.** Auto-confirmed subscriptions (a signed-in user subscribing to their own comment's thread) send no confirmation mail and so aren't counted here — they're bounded by the limiter and the per-email cap.

- **It only counts confirmation mail.** Digests are sent by the cron to addresses that already confirmed, so they're outside this ceiling — an attacker can't trigger them. But it does mean this budget is not a bound on your *total* Resend spend, only on the part an unauthenticated caller can cause.

**Tuning.** Both caps are operator-settable, from **/admin/settings → Moderation → Confirmation-email ceiling**, or as the `CONFIRM_SEND_BURST_MAX` / `CONFIRM_SEND_DAILY_MAX` vars (defaults 20/minute and 200/day). The admin dial takes effect on the next request; no redeploy either way.

- **Raising them.** The burst cap is deliberately tight *because* it is global, so a post that gets busy can plausibly turn away a genuine subscriber for a minute. The signal is a `confirmation email budget exhausted` line in `wrangler tail`, tagged with the scope that denied — check for it before assuming a reader's report of "too many requests" is something else.
- **Lowering them.** Resend's free tier is 100 emails/day, so the 200 default sits *above* it on purpose: the intent is that your provider's own limit, not this one, is what a normal instance notices, and that this only engages on abuse. If you'd rather Garrul stop before your provider starts rejecting, set the daily cap below 100 minus your expected digest volume.
- **There is no "off".** Both clamp to a floor of 1, unlike the other numeric dials where `0` disables a check. A ceiling of 0 would refuse every new subscription while looking like it had been switched off, so that value isn't reachable — set the cap high if you want the ceiling out of the way.

The two **windows** (60s and 24h) stay code constants. What needs retuning in practice is how many sends you get, not the period they're counted over — and the `scope` strings that name them are a primary key seeded by migration `0018`, so splitting or renaming a window is a migration rather than a setting.

## The Durable Object backend (opt-in)

Bind a `RateLimitShard` Durable Object and the limiter moves off the Cache API onto it. Uncomment the block in `wrangler.example.toml` (search for `RATE_LIMIT_DO`), copy it into your `wrangler.toml`, and redeploy. Nothing else changes — no new secrets, no migration to your D1 database, no code change.

**What it fixes.**

- **The concurrency race (#2) is closed.** One Durable Object instance is the single authority for an identity, and it decides without yielding, so concurrent requests are counted one at a time. The configured cap becomes the actual cap.
- **The per-colo split (#1) is closed.** One instance per identity means one counter, not one per datacenter.
- **The shared envelope becomes a real backstop.** On the Cache API it races exactly like the per-scope bucket and multiplies with it. On the Durable Object both buckets are decided in the same pass against the same state, so the per-identity ceiling across all endpoints is genuinely enforced — arguably the biggest practical gain here.

**What it does not fix.**

- **IPv6 rotation across /64s.** Someone with many prefixes is still many identities. Nothing inside Garrul can fix that; see the WAF note above.
- **Buckets reset when a shard goes cold.** Counters are held in memory, deliberately — persisting them would spend a storage write on every allowed request for state that is worthless within a window of itself. Cloudflare hibernates idle Durable Objects and discards their memory, so a caller pacing itself slower than the hibernation interval can exceed the *long* window (the 10-minute one). The short window is unaffected in practice. Bucket eviction under memory pressure behaves the same way. Resets only ever *loosen* the limit — they never produce a spurious 429.
- **It is not a hard ceiling either.** It is a much better cost-raiser. WAF is still the ceiling.
- **On the free plan, a sustained flood can switch it off.** The free tier allows 100,000 Durable Object requests/day and Cloudflare fails further operations of that type once you exceed it. Every metered call is one request, **including the ones the limiter blocks**, so roughly 100,000 requests to any write endpoint exhausts the day's budget — after which the shard errors, the limiter fails open, and you are back to no limiting until the quota resets at 00:00 UTC. The Cache API backend has no equivalent cliff. So on the free plan the Durable Object is strictly better under normal load and worse under exactly the sustained flood it exists to counter, which is the sharpest reason the WAF rule above is not optional if you expect one. On the paid plan the equivalent is a bill rather than a cliff.

**Latency.** This is the real running cost, and it is not free. A shard lives in one datacenter — wherever it was first reached — so every metered write endpoint call now pays a round trip to that one location instead of reading a colo-local cache entry. For a reader near the shard that is single-digit milliseconds; for one on the far side of the world it can be a couple of hundred, added to every comment post, vote and reaction. Reads are untouched: the comment tree is still served from the edge cache, so this shows up when someone interacts, not when they load a page. A hung shard is capped at 2 seconds, after which the request is allowed through and logged as degraded rather than left waiting.

**Failure behavior.** Unreachable or misbehaving shard → the request is allowed through unmetered and a `ratelimit.degraded` line is logged with `backend: "do"`. Same fail-open posture as the Cache API path, which is the right trade for a defense mechanism: a limiter outage must not take every write endpoint down with it. Watch for it with `wrangler tail`.

**Cost.** On the Workers free plan: 100,000 Durable Object requests/day, shared account-wide across every Durable Object you run. One metered write endpoint call is one Durable Object request, allowed or blocked — see the quota cliff above for what happens when you run out. The shard never writes to storage, so the SQLite storage quota is untouched, and because the shard is always eligible to hibernate it uses a negligible fraction of the 13,000 GB-s/day duration allowance. Requests are spread over 8 shards; that number is a constant in `src/lib/ratelimit.ts` and changing it reshuffles every bucket once.

**Rolling back.** Remove the `[[durable_objects.bindings]]` block and redeploy. The limiter falls straight back to the Cache API and there is no state to clean up. Leave the `[[migrations]]` block and the exported class alone — deleting the class would need a `deleted_classes` migration for no benefit.

## What's still possible (deferred)

These aren't in the box yet — open an issue if you need them:

- Disposable-email blocklist (relevant only for OAuth/notify-me flows).
- IP-reputation lookups (StopForumSpam, AbuseIPDB) — would need to handle raw IPs, conflicts with privacy stance.
- Bayesian / locally-trained classifier.
- CleanTalk or other classifier vendors — the adapter interface is in `src/lib/spam/`; adding one is one new file.
- Per-window control over the [confirmation-email ceiling](#the-confirmation-email-ceiling) — the caps are settings as of 2.8.0, but the 60s / 24h windows they divide are still constants, and adding or renaming one is a migration (the scope strings are a primary key).

## Operating the queue

Flagged comments appear at `/admin/queue?status=pending`. Each row has Approve / Spam / Delete buttons. Approving fires the `comment.approved` webhook and adds the comment to the public tree on next page load.

The admin dashboard at `/admin` shows which anti-spam layers are active for the current deployment.

## Logs

When a comment is flagged, a JSON log line is emitted via `console.log`:

```json
{
  "level": "info",
  "msg": "spam.flagged",
  "reasons": ["link_count:5", "first_comment"],
  "post_slug": "hello-world",
  "provider": "anon"
}
```

Adapter failures (HTTP error, malformed response) emit `spam.adapter.error` with the provider name. **Comment bodies, author names, emails, and IPs are never logged** — only the signal names that fired.

Tail with `wrangler tail` or query in your log aggregator.
