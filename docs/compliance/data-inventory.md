# Personal-data inventory

**You are the controller.** Garrul is software you run; the personal data in
your instance is yours, on your infrastructure, under your legal
responsibility. Nothing here is legal advice — it is a factual description of
what the code stores, so you can fill in a record of processing activities
(GDPR Art. 30) or a CCPA notice-at-collection without reverse-engineering the
schema yourself.

Everything below is stated against a specific `file:line` in the version of the
code you checked out. If a claim and the code disagree, the code is right and
this doc is a bug — please report it.

Legal-basis columns say what a *typical* blog deployment relies on. That call is
yours to make and defend; see [`gdpr.md`](gdpr.md) for the reasoning.

---

## D1 — the durable store

D1 is the only store that survives a redeploy. Everything else is a cache or a
short-TTL token.

### Tables holding personal data

| Table | Personal fields | Purpose | Typical Art. 6 basis | Retention | Reached by erasure? | In the export? |
| --- | --- | --- | --- | --- | --- | --- |
| `users` | `name`, `email`, `avatar_url`, `provider`/`provider_id`, `created_at` | Identity and comment attribution | Legitimate interests (contract, if you have accounts + terms) | Indefinite until erased | **Yes** — `name` → placeholder, `email`/`avatar_url`/`provider_id` → NULL, `erased_at` stamped | Yes (whole row) |
| `comments` | `body_md`, `body_html`, `ip_hash`, `user_agent` | Publishing the comment; abuse investigation | Legitimate interests | Indefinite; `ip_hash`/`user_agent` bounded by `IP_HASH_RETENTION_DAYS` if set | **Partly** — `ip_hash` + `user_agent` always cleared; bodies only when the admin ticks *redact bodies* | Yes (whole row) |
| `reports` | `reporter_user_id`, `reporter_ip_hash`, `reason` | Abuse reporting, duplicate-report dedup | Legitimate interests | Indefinite; `reporter_ip_hash` bounded by `IP_HASH_RETENTION_DAYS` | **Partly** — `reporter_ip_hash` cleared | Yes, reports they filed |
| `subscriptions` | `email`, `token`, `confirm_token` | Reply notifications the subscriber asked for | Consent | Until unsubscribe or erasure | **Yes** — rows matching their address are deleted outright | Yes |
| `notifications` | `subscription_id`, `comment_id` | The pending-digest queue | Consent (rides on the subscription) | Until sent; no timer | **Yes** — deleted with the subscription | No — see *Known limitations* |
| `votes`, `reactions`, `page_votes`, `page_reactions` | `user_id` + target | Scores and reaction counts | Legitimate interests | Indefinite | **No, deliberately** — they hold nothing but a link to a now-anonymous account, and deleting them would silently restate every score the thread has shown | Yes |
| `telegram_links` | `tg_user_id`, `tg_chat_id`, `user_id` | Operator notifications to a linked chat | Consent (the operator's own) | Until unlinked or erased | **Yes** — deleted | Yes |
| `audit_log` | `admin_id`, `target_id`, `reason` (free text) | Accountability for moderation acts | Legitimate interests / legal obligation | Indefinite by default; bounded by `AUDIT_LOG_RETENTION_DAYS` if set | **No, by design** — see below | Yes, as `moderation_actions`, with `admin_id` removed |
| `webhook_deliveries` | `payload` — rendered comment body + author name | Outbound delivery + retry | Legitimate interests | **30 days, always on** (`src/lib/webhook.ts:360`) | **No** — see *Known limitations* | No |

`audit_log` is deliberately outside erasure. An audit row is a record of *the
operator's* act, and rewriting it on the subject's request would make the
accountability trail meaningless. Since 2.6.0 the rows carry no personal data
about anyone but the acting admin: `sub.unsubscribe`/`sub.resend` no longer
record the subscriber's address, and `ban`/`unban`/`role.*` no longer record the
target's display name (`src/db/migrations/0019_audit_log_pii.sql` clears the ones
already written). What remains is `target_id` — an opaque ULID that resolves to
an anonymized row after erasure — and `reason`, free text a moderator typed.
**Skim `reason` before releasing an export**; nothing stops a moderator from
writing a name in it.

### Tables holding no subject data

| Table | Contents |
| --- | --- |
| `posts` | `slug`, `title`, `url` — page metadata |
| `spam_verdicts` | `comment_id`, `source`, `verdict`, `score`, `raw`. `raw` is adapter metadata only: `{response, pro_tip}` for Akismet (`src/lib/spam/akismet.ts:86`), `{cached, model, response}` for Workers AI where `response` is the clipped SPAM/HAM token (`src/lib/spam/workers-ai.ts:102`). It does **not** echo comment content. |
| `webhook_endpoints` | Operator config: `url`, `secret`, `events` |
| `saved_replies` | Canned moderator text, `owner_id`. Staff-authored, not subject data. |
| `settings`, `email_send_budget`, `_migrations` | Instance configuration and counters |

---

## KV

| Namespace | Key | Contents | TTL |
| --- | --- | --- | --- |
| `SESSIONS` | `sess:<32 random bytes, hex>` | `{user_id, expires_at}` — no name, no email | 30 days, slid forward at most once a day (`src/lib/session.ts:55`) |
| `OAUTH_STATE` | widget handoff / `tg:link:<token>` | `{user_id}` | 60 s (`src/lib/oauth.ts:395`) / 600 s (`src/routes/telegram.ts:65`) |
| `RATE_LIMITS` | `spamcache:<first 32 hex of SHA-256(body_md)>` | The Workers-AI verdict for that body. Only written when `SPAM_PROVIDER=workers-ai`. | 6 h (`src/lib/spam/workers-ai.ts:22`) |
| `TREE_CACHE` | resolved settings, `meta:latest-release` | Instance config and the version check — no personal data | 1 h (`src/lib/settings.ts:258`) |

The spam cache key is **derived from the comment text**. It is a truncated hash,
not the text, and it expires in six hours — but if the same body is submitted
twice inside that window, the key's existence reveals that. Worth knowing; not
worth a policy paragraph.

OAuth *state* is a signed cookie, not a KV row, despite the namespace name
(`src/lib/oauth.ts`). The namespace is reused for the two short-lived tokens
above.

---

## Edge Cache API (`caches.default`)

Not KV, and never backed up. Two users:

- **Comment tree pages** — the first page of a thread, including public comment
  bodies and author display names. Short `max-age`
  (`src/lib/response-cache.ts:133`), and busted per slug on write, on
  moderation, and on erasure (`src/lib/moderation.ts:224-226`). Nothing here is
  more exposed than the page a reader already sees.
- **Rate-limit counters** — keyed by identity: `user:<id>` for a signed-in
  author, otherwise the `ip_hash` (`src/routes/api.comments.ts:433-436`). Just
  timestamps, expiring with the window.

---

## Not collected

Worth stating explicitly, because a privacy policy is stronger for it:

- **No raw IP addresses**, anywhere, ever — logged or stored. Every IP goes
  through HMAC-SHA-256 keyed on `IP_HASH_SECRET`, via the single entry point
  `src/lib/ip-hash.ts`. IPv6 is truncated to its network prefix before hashing.
  Read [`../ip-hashing.md`](../ip-hashing.md) before treating a hash as
  anonymous — against someone who holds the secret, it is not.
- **No analytics, tracking pixels, ad tags, or fingerprinting.**
- **No Gravatar.** Anonymous avatars are identicons generated locally from the
  user id.
- **No PII in logs.** `src/lib/log.ts` emits JSON with a request id; names,
  emails and comment bodies are out of scope by convention.
- **One cookie**, `__Host-garrul_sess`, strictly necessary for sign-in. Nothing
  is set for a reader who only reads.
- **Comment drafts** live in the visitor's own `localStorage` and are never
  transmitted.

---

## Known limitations

These are real gaps in the current version. They belong in your risk assessment,
not in a footnote.

1. **`webhook_deliveries.payload` is outside erasure.** It holds rendered
   comment bodies and author display names, and erasure never touches it, so a
   copy of an erased user's comment can survive in the delivery log. It is
   pruned unconditionally at 30 days (`src/lib/webhook.ts:360`), so the window
   is bounded and short — but for up to 30 days after a completed Art. 17
   request the data is still there. If that is unacceptable for your
   deployment, disable webhooks or dump the table after processing an erasure.

2. **`notifications` is not in the export.** It holds only a
   `subscription_id` + `comment_id` pair, both of which the export already
   contains via the subscription and the comment. Omitting it loses nothing the
   subject can't already see — but the export is not literally every row that
   references them.

3. **`audit_log.reason` is free text.** No validation stops a moderator from
   typing a name or an address into it. The export includes `reason`; review it
   before handing the file over.

4. **`ip_hash` retention is off by default.** Left unset, an instance keeps
   every hash it has ever written, and a D1 dump carries all of them.
   `IP_HASH_RETENTION_DAYS` bounds `comments.ip_hash` and
   `reports.reporter_ip_hash` — but never `users.provider_id` for
   `provider='anon'` rows, because there the hash *is* the account.
   [`../ip-hashing.md`](../ip-hashing.md) has the full posture.

5. **`audit_log` retention is off by default too**, and for the same reason: an
   upgrade must not start deleting an operator's moderation history. Until you
   set `AUDIT_LOG_RETENTION_DAYS`, that table grows without bound.

## See also

- [`gdpr.md`](gdpr.md) — data-subject rights mapped to mechanisms
- [`ccpa.md`](ccpa.md) — the same data in CCPA/CPRA's category vocabulary
- [`subprocessors.md`](subprocessors.md) — who else receives any of this
- [`dsar-runbook.md`](dsar-runbook.md) — what to actually do when a request arrives
- [`../ip-hashing.md`](../ip-hashing.md) — the hash in detail
- [`../privacy-policy.template.md`](../privacy-policy.template.md) — a policy you can edit
