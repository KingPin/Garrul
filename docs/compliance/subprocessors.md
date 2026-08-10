# Subprocessor register

**You are the controller / business.** Every service below processes personal
data *on your behalf, under your contract with them*. Garrul receives nothing and
is not in this list. Nothing here is legal advice — it is a factual list of who
receives what, and when, so you can fill in your own Art. 30 record, your Art.
13(1)(e) recipient disclosure, and your CCPA service-provider list.

Which of these are active depends entirely on your configuration. A default
deployment has exactly **one**: Cloudflare.

Field-level detail on the underlying data is in
[`data-inventory.md`](data-inventory.md).

---

## Always active

### Cloudflare

| | |
| --- | --- |
| **Role** | Hosting and infrastructure processor |
| **When** | Always. Garrul *is* a Cloudflare Worker. |
| **Products** | Workers (compute), D1 (the database), KV (sessions, tokens, caches), Cache API (edge cache, rate-limit counters), Turnstile, optionally Workers AI and Durable Objects |
| **Receives** | Everything the instance stores, plus what any edge provider necessarily sees: the reader's raw IP address and request headers, as connection metadata |
| **Contract** | Cloudflare's DPA, incorporating the EU SCCs. Accept it in your Cloudflare account; you do not need a separate agreement per Worker. |

Two facts worth being precise about, because "Garrul never stores raw IPs" is
sometimes read as more than it says:

- **Cloudflare sees every raw IP** — it terminates the TLS connection. What
  Garrul guarantees is that no raw IP is ever *stored or logged by the Worker*;
  the edge's own visibility is Cloudflare's, under Cloudflare's notice.
- **Turnstile siteverify is sent the raw client IP** as `remoteip`
  (`src/lib/turnstile.ts:50`), on the anonymous comment path only. This is a
  transfer *to Cloudflare*, which already saw that IP at the edge, so it
  discloses nothing new — but it is a transfer, and if you enumerate them you
  should enumerate this one.

**Turnstile also runs in the reader's browser.** The widget mounts it lazily,
inside an iframe your own Worker serves, which then loads
`challenges.cloudflare.com/turnstile/v0/api.js`
(`src/routes/embed-iframe.ts:231`). So a *reader* who focuses the comment box
makes a request to Cloudflare from their own browser, disclosing their IP and
user-agent to it. It does not fire for someone who only reads the page.

**Data location.** Workers execute at the edge colo nearest the visitor,
worldwide — that is what a CDN is. D1 accepts a location hint at creation time
(e.g. `--location=weur`) that biases the primary's placement; check Cloudflare's
current documentation before relying on it for a data-residency claim, and rely
on the SCCs in the DPA for the transfer itself either way.

---

## Active only when you enable them

### Resend — transactional email

| | |
| --- | --- |
| **Role** | Email delivery processor |
| **When** | `EMAIL_PROVIDER=resend` with `RESEND_API_KEY` + `EMAIL_FROM` set. Off by default; with it off, subscriptions cannot be confirmed and no digest is sent. |
| **Receives** | The recipient's **email address**, and the message body — which contains **comment excerpts and author display names** for a reply digest, and an unsubscribe link containing the subscription token |
| **Not sent** | IP hashes, user agents, account ids |
| **Contract** | Resend's DPA. US-based; check its current subprocessor list and transfer mechanism. |
| **Code** | `src/lib/email.ts` — the sole implementation. `EMAIL_PROVIDER` leaves room for more adapters; none ship today. |

### Akismet — spam classification

| | |
| --- | --- |
| **Role** | Content-scoring processor (Automattic) |
| **When** | `SPAM_PROVIDER=akismet` with an API key. Off by default. |
| **Receives** | The **comment body**, the **author display name**, the **user-agent** string, your site URL and the post permalink (`src/lib/spam/akismet.ts:38-53`) |
| **Not sent** | The author's **email address** — deliberately omitted so OAuth addresses don't egress to Automattic. The **real IP** — `user_ip` is hard-coded to `127.0.0.1`, a neutral placeholder that passes Akismet's required-fields check without disclosing anything. |
| **Contract** | Automattic's DPA. US-based. |

This is the transfer most likely to surprise a reader: enabling Akismet means
**every comment body leaves your infrastructure** for a US vendor. It buys real
spam-catching accuracy. Disclose it explicitly in your policy — the template does
not enable it, so if you turn it on, edit the policy.

### Workers AI — spam classification

| | |
| --- | --- |
| **Role** | Content-scoring, inside Cloudflare |
| **When** | `SPAM_PROVIDER=workers-ai`. Off by default. |
| **Receives** | The comment body, truncated to 2000 characters, in a prompt to `@cf/meta/llama-3.1-8b-instruct` (`src/lib/spam/workers-ai.ts:21-23`) |
| **New subprocessor?** | **No.** It stays within Cloudflare, already your processor. That makes it the low-transfer choice if you want machine classification but not a US vendor relationship. |
| **Note** | Verdicts are cached in KV for 6 h under a key derived from a truncated SHA-256 of the body. |

### Telegram — operator notifications

| | |
| --- | --- |
| **Role** | Messaging processor (Telegram FZ-LLC) |
| **When** | A bot token is configured *and* an operator links a chat. Off by default. |
| **Receives** | Comment content and author display names in notification messages, plus the linked operator's Telegram user and chat ids |
| **Contract** | Telegram's terms. Note it is the **operator** whose chat identifiers are stored, so an operator is a data subject of their own instance here. |
| **Code** | `src/lib/telegram.ts`, `src/routes/telegram.ts`, [`../telegram.md`](../telegram.md) |

### OAuth providers — GitHub, Google, Facebook, X, Discord

| | |
| --- | --- |
| **Role** | **Not your processor.** Each is an independent controller of the sign-in step. |
| **When** | Per provider, when you configure its client id and secret (`src/lib/oauth.ts:27-32`) |
| **They receive** | That a person authenticated to your site — inherent to OAuth. You send them no comment data. |
| **You receive** | Display name, email (if the provider releases it), avatar URL, and a stable provider user id |
| **Disclose** | Which providers you enabled, and that signing in discloses the visitor's use of your site to that provider |

Nothing in the code stops you from shipping zero providers: anonymous commenting
with Turnstile works on its own, and is the lowest-disclosure configuration.

### Webhook endpoints — whoever you point them at

| | |
| --- | --- |
| **Role** | Whatever you make it. **This is the one entry you must fill in yourself.** |
| **When** | You add an endpoint in Admin → Webhooks. None by default. |
| **Receives** | The event payload, which contains **rendered comment bodies and author display names** |
| **Retention** | Payloads are also retained locally in `webhook_deliveries` for retry, pruned unconditionally at 30 days (`src/lib/webhook.ts:360`) |

Two consequences:

- **A webhook is a disclosure to a third party** and belongs in your policy and
  your Art. 30 record by name. Garrul cannot know who it is.
- **If the recipient is an ad-tech or analytics vendor rather than a service
  provider under contract, you may have created a CCPA "sale" or "share"** — and
  the "we do not sell or share" position in [`ccpa.md`](ccpa.md) stops being
  true for your deployment. Slack, Discord and Telegram adapters used for
  internal moderation alerts are the ordinary, safe case.

---

## Minimal-transfer configuration

For an operator who wants **Cloudflare as the only processor** — the tightest
posture the software supports:

| Setting | Value | Effect |
| --- | --- | --- |
| OAuth client ids/secrets | none | Anonymous commenting with Turnstile only. No provider learns anything. |
| `SPAM_PROVIDER` | unset, or `workers-ai` | Built-in heuristics only, or classification that stays inside Cloudflare. **Never `akismet`** — that is the one transfer that ships comment text off-platform. |
| `EMAIL_PROVIDER` / `RESEND_API_KEY` | unset | No email subprocessor. Subscriptions can't be confirmed, so nobody's address is collected at all. |
| Telegram bot token | unset | No messaging subprocessor. |
| Webhooks | none configured | No operator-chosen recipients. |
| `IP_HASH_RETENTION_DAYS` | e.g. `90` | A defined retention period instead of "forever". |
| `AUDIT_LOG_RETENTION_DAYS` | e.g. `365` | Same, for moderation history. |

That configuration still collects hashed IPs, user agents, display names and
comment text — it is minimal, not zero. But there is exactly one processor to
name, one DPA to accept, and one transfer mechanism to justify.

## See also

- [`data-inventory.md`](data-inventory.md) — what each store holds
- [`gdpr.md`](gdpr.md) — Art. 28 processors vs. independent controllers
- [`ccpa.md`](ccpa.md) — service providers, and when a webhook becomes a "sale"
- [`../ANTISPAM.md`](../ANTISPAM.md) — choosing a spam provider on the merits
- [`../webhooks.md`](../webhooks.md) — payload format and adapters
