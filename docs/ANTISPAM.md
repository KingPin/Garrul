# Anti-spam

Garrul defends against spam in layers. The base protections below are **always on** and ship with every instance; the optional layers are **off by default** — turn on what you need.

## What's always on

These don't need configuration; they ship with every Garrul instance:

- **Turnstile** — Cloudflare's CAPTCHA-alternative. Required for anonymous POSTs whenever `TURNSTILE_SITE_KEY` is set. See [Turnstile mount timing](#turnstile-mount-timing) for when it loads and what its three visitor-facing messages mean.
- **Rate-limit** — sliding window on the edge Cache API (not KV), keyed on the hashed client IP for anonymous callers and on the user id for signed-in ones. 1 anonymous comment per 10s and 5 per 10 min by default; signed-in authors get 3 per 10s and 60 per 10 min. Every caller is also held under one shared per-identity envelope across all endpoints. An optional [Durable Object backend](#the-durable-object-backend-opt-in) makes the counting atomic and global. **Read [Rate-limit accuracy](#rate-limit-accuracy-known-limitations) before you rely on these numbers as a hard ceiling** — they are not one.
- **Markdown sanitizer** — strict allowlist; only `https:`/`http:`/`mailto:` links survive, raw HTML and `<img>` are dropped, every link gets `rel="nofollow ugc noopener" target="_blank"`.
- **Field honeypot** — a hidden `website` input in the embed form. If a bot fills it, the POST is rejected with HTTP 400.

## Turnstile mount timing

Turnstile does not load with the page. The widget mounts its anti-spam iframe — `/embed/turnstile-frame`, which then pulls Cloudflare's `api.js` and its challenge platform — when the visitor **first focuses the comment box**. `api.js` and its dependencies are roughly twice the size of the whole comment widget, and almost nobody who loads a page comments, so a reader who never touches the composer never downloads any of it.

Consequences worth knowing before you debug a report:

- **In DevTools, expect zero `turnstile` requests on load.** They appear on first focus of the composer (the textarea, the name field, anything in the form except the submit button). This is correct behavior, not a broken widget. Reply forms mount on open, since opening one is already the intent signal.
- **A visitor can submit before a token exists** — clicking Post without focusing anything is reachable, because a restored draft pre-fills the box silently. The widget shows `Checking…` on the button and waits up to 9 seconds.

### The three messages, and what each one means

When that wait doesn't produce a token, the visitor sees one of three things. They are deliberately different, because the operator action differs:

| Message | Meaning | Post button | What to check |
| --- | --- | --- | --- |
| "Complete the anti-spam check above, then post again." | Turnstile is working and something has to happen before it will mint a token — usually that the visitor clicks the checkbox. | Re-enabled | Nothing. Expected in managed mode. Deferring the mount makes this somewhat more likely, since Turnstile has less passive observation time before it has to mint a token. This message is also used when a challenge timed out and reset itself, where there may be nothing visible to click; Turnstile re-runs on its own, so posting again a moment later works. |
| "The anti-spam check didn't load. Check your connection or reload the page." | The iframe never reported in at all. | Re-enabled | Host CSP missing `frame-src` for the Worker origin, the host site missing from `ALLOWED_ORIGINS`, or a blocked/failed frame document. Also expected briefly (up to 5 minutes) right after an upgrade, since the frame document is cached with `max-age=300` and an older copy doesn't send the newer status messages. |
| "Anti-spam check failed to load. Reload the page; …" | Turnstile itself reported an error — usually `api.js` unreachable. | **Stays disabled** | `https://challenges.cloudflare.com` reachability, and that `TURNSTILE_SITE_KEY` matches the site key configured in Cloudflare. |

Only the third message disables the composer, and it is sticky: nothing later re-enables the button, and only a page reload clears it. The first two are recoverable and always hand the button back.

That stickiness is deliberate but blunt. The widget latches on **any** error Turnstile reports, and Turnstile's error callback also fires for transient conditions — an internal `300***` code, or a network blip while the challenge is executing — not just for the persistent causes above. Cloudflare's own guidance for those is to reset the widget and retry, which the widget does not currently do. So a report of a permanently dead Post button is *most often* `challenges.cloudflare.com` being unreachable or a site-key mismatch, but a one-off transient error looks identical to the visitor and is cleared the same way, by reloading. If you get an isolated report you can't reproduce and reachability checks out, a transient error is the likely explanation — don't keep hunting for a misconfiguration that isn't there.

## Optional layers

All three heuristics + the classifier adapter flip a flagged comment to `status='pending'` so it lands in the admin queue at `/admin/queue?status=pending`. **Nothing is ever silently dropped.** You decide whether to approve.

**The three heuristics are runtime-tunable.** Each one has an env var below that sets the deploy-time default, but you can retune all three from **Admin → Settings → Moderation** without a redeploy — which is how you want to work while watching the queue. An admin save writes a `settings` row that overrides the env var (precedence is DB > env > built-in default); "Reset to defaults" clears the overrides and hands control back to `wrangler.toml`. The classifier in §4 stays deploy-time: it needs credentials, and a dropdown offering a provider the deploy can't reach is worse than an env var.

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

Highest precision of the three heuristics. Cost: you have to log in and approve. Use on low-traffic blogs; skip on busy ones.

### 4. Content classifier (`SPAM_PROVIDER`)

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
| Subscribe | `PENDING_PER_EMAIL_CAP` — at most 5 unconfirmed rows per address |

**What the race actually buys an attacker.** Every control in that table is unaffected by it, so what #2 loosens is a *rate*, not an action — it cannot buy a second report on the same comment, or a double-counted vote.

On the IP-keyed buckets it is the cheapest bypass currently available. It used not to be: while Garrul hashed the full IPv6 address, one household supplied 2^64 distinct identities and per-IP limiting was unenforceable over IPv6 no matter what the race did. IP hashing now normalizes IPv6 to its /64, so a household is one identity — which closed the larger hole and left this one as the front edge. On the user-id-keyed buckets (signed-in comment POST, edit, delete) and the Telegram route the race is the *only* bypass, and those cost an attacker a real account, which you can ban.

**What to do if this matters for your instance.** Two options, and they are not alternatives — under active attack, use both:

1. **Put Cloudflare WAF rate-limiting rules in front of the Worker.** They run before your code, count accurately, and can key on things Garrul can't see. This is the real ceiling.
2. **Enable the Durable Object backend below.** It closes #1 and #2 inside Garrul, which is what you want for the buckets WAF can't express — the per-user-id ones especially.

Garrul's limiter is the floor that ships in the box, not the ceiling you should rely on under active attack.

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

**Failure behavior.** Unreachable or misbehaving shard → the request is allowed through unmetered and a `ratelimit.degraded` line is logged with `backend: "do"`. Same fail-open posture as the Cache API path, which is the right trade for a defense mechanism: a limiter outage must not take every write endpoint down with it. Watch for it with `wrangler tail`.

**Cost.** On the Workers free plan: 100,000 Durable Object requests/day, shared account-wide. One metered write endpoint call is one Durable Object request. The shard never writes to storage, so the SQLite storage quota is untouched. Requests are spread over 8 shards; that number is a constant in `src/lib/ratelimit.ts` and changing it reshuffles every bucket once.

**Rolling back.** Remove the `[[durable_objects.bindings]]` block and redeploy. The limiter falls straight back to the Cache API and there is no state to clean up. Leave the `[[migrations]]` block and the exported class alone — deleting the class would need a `deleted_classes` migration for no benefit.

## What's still possible (deferred)

These aren't in the box yet — open an issue if you need them:

- Disposable-email blocklist (relevant only for OAuth/notify-me flows).
- IP-reputation lookups (StopForumSpam, AbuseIPDB) — would need to handle raw IPs, conflicts with privacy stance.
- Bayesian / locally-trained classifier.
- CleanTalk or other classifier vendors — the adapter interface is in `src/lib/spam/`; adding one is one new file.

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
