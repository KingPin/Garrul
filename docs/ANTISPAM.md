# Anti-spam

Garrul defends against spam in layers. The base protections below are **always on** and ship with every instance; the optional layers are **off by default** — turn on what you need.

## What's always on

These don't need configuration; they ship with every Garrul instance:

- **Turnstile** — Cloudflare's CAPTCHA-alternative. Required for anonymous POSTs whenever `TURNSTILE_SITE_KEY` is set.
- **Rate-limit** — KV-backed sliding window keyed on the hashed client IP. 1 comment per 10s and 5 per 10 min by default.
- **Markdown sanitizer** — strict allowlist; only `https:`/`http:`/`mailto:` links survive, raw HTML and `<img>` are dropped, every link gets `rel="nofollow ugc"`.
- **Field honeypot** — a hidden `website` input in the embed form. If a bot fills it, the POST is rejected with HTTP 400.

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
