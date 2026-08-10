# GDPR: rights, bases, and the mechanisms that serve them

**You are the controller.** If you run a Garrul instance that European visitors
comment on, the GDPR obligations are yours — not the project's, not
Cloudflare's. Garrul is a tool; compliance is a property of *your deployment*,
which is why this doc never claims Garrul "is GDPR compliant" and neither should
you.

**Not legal advice.** This maps articles onto mechanisms that exist in the code
so you can answer a request without guessing. Which lawful basis you rely on,
what you write in your policy, and how you answer a regulator are your calls.

Start with [`data-inventory.md`](data-inventory.md) — every claim here assumes
you know what is stored where.

---

## Controller, processor, and what Garrul is

You are the **controller**: you decide that comments are collected, why, and for
how long. Garrul is software you execute — it is not a party to the processing
and has no access to your data.

Your **processors** are the services that touch the data on your behalf:
Cloudflare always, plus Resend, Akismet, Workers AI, Telegram and any webhook
endpoint you configure. Each needs a legal basis for the transfer and, in most
cases, an Art. 28 data-processing agreement you enter into directly.
[`subprocessors.md`](subprocessors.md) lists who receives what, when.

An **OAuth provider** is not your processor. When a visitor signs in with GitHub,
they disclose their own profile to you; the provider is an independent controller
of that step. What you then store is yours.

---

## Lawful basis (Art. 6)

One basis per purpose, not one per instance. A typical blog deployment:

| Purpose | Data | Basis and reasoning |
| --- | --- | --- |
| Publishing a comment and attributing it | `comments`, `users.name`/`avatar_url` | **Legitimate interests** (Art. 6(1)(f)). The visitor deliberately submitted text for publication; running a discussion is the interest, and their expectation matches it. If you have accounts plus accepted terms, **contract** (6(1)(b)) also fits. |
| Abuse prevention: rate limiting, spam scoring, ban evasion | `ip_hash`, `user_agent`, `spam_verdicts` | **Legitimate interests.** Keeping a comment section usable is a recognised interest, and hashing rather than storing the IP is the data-minimisation that makes the balance defensible. |
| Reply notifications by email | `subscriptions.email`, `notifications` | **Consent** (6(1)(a)). Opt-in, double-confirmed, and revocable by one click in every email. Do not fold this into legitimate interests. |
| Moderation accountability | `audit_log` | **Legitimate interests**, or **legal obligation** (6(1)(c)) where a content law requires you to show what you removed and when. |
| Operator's own Telegram link | `telegram_links` | **Consent** of the operator, who is also the subject. |

Two consequences worth writing down:

- **Consent-based processing needs a withdrawal path.** The unsubscribe link is
  it. Do not repurpose a subscriber's address for anything else.
- **Legitimate interests needs a balancing test you can produce.** One
  paragraph per purpose, written before the request arrives, is enough.

---

## Data-subject rights

### Art. 15 — Access

`GET /admin/api/users/:id/export`, or the **Export personal data** panel on the user's
page in the admin UI (`/admin/users/:id`). Returns one JSON file covering every
store that holds their data: the account row, comments, reports they filed,
subscriptions matching their address, votes, reactions, page engagement,
Telegram links, spam verdicts recorded against their comments, and moderation
actions targeting them.

Two shaping decisions, both deliberate:

- **`ip_hash` and `user_agent` are included.** They are the subject's own data.
  Withholding them would make the export a false statement about what you hold.
- **`audit_log.admin_id` is excluded.** Moderation actions taken against the
  subject are their data; *which moderator* took them is a third party's, and
  Art. 15(4) does not require disclosing it. Only action, reason and timestamp
  are exported.

Art. 15 also entitles them to the *context*: purposes, categories, recipients,
retention, and the source of the data. The export is the data; that context is
your privacy policy plus [`subprocessors.md`](subprocessors.md).

Before sending the file, read [`dsar-runbook.md`](dsar-runbook.md) — an export
containing an `ip_hash` is more sensitive than it looks.

### Art. 16 — Rectification

- **Display name and avatar**: refreshed from the provider on every sign-in
  (`src/db/queries.ts:364-380`). The subject fixes them at the provider and signs
  in again; nothing is needed from you.
- **Comment text**: the author edits their own comment within
  `EDIT_WINDOW_MINUTES` (default 15, configurable to 7 days, 0 disables). Past
  that window it is a manual correction by an admin.
- **Email address**: see *Known limitations*. There is no in-product path.

### Art. 17 — Erasure

**Admin → user page → Erase user data.** Irreversible, admin-only,
audit-logged. It anonymizes rather than deletes, because the row has to survive
for reply chains to stay readable. Concretely
(`src/db/queries.ts:1452`, `src/lib/moderation.ts:181`):

- `users.name` → placeholder, `email`/`avatar_url` → NULL, `erased_at` stamped.
- `users.provider_id` → NULL. For an OAuth account that is the provider's user
  id; for an anonymous account **it is the `ip_hash` itself**, so clearing it is
  the whole point.
- `comments.ip_hash` and `comments.user_agent` → NULL on every comment they
  wrote, including already-soft-deleted ones.
- `reports.reporter_ip_hash` → NULL on reports they filed.
- `subscriptions` for their address, and queued `notifications` riding on them,
  deleted outright.
- `telegram_links` deleted — those carry an external chat id.
- Their sessions are revoked, so nothing keeps acting as them.
- The cached first page of every thread they appear on is busted at the edge, so
  the old name stops being served immediately.

The whole thing runs as one `db.batch` — D1 wraps that in a transaction, because
a half-erased user is worse than an un-erased one.

**Comment bodies are kept by default**, with the author anonymized, so
conversations other people took part in stay readable. That is the Art. 17(3)(a)
freedom-of-expression carve-out doing real work — but it is a judgement call, so
the erase panel has a **redact bodies** option that blanks the text and marks
the comments deleted. Use it when the personal data is *in the text*: a name, an
address, an employer. Author-level scrubbing never reaches that.

If the subject signs in again afterwards they get a **new** account. The erased
one is not restored.

### Art. 20 — Portability

The same export. It is JSON, machine-readable, structured, and carries an
`export_version` so a consumer can tell shapes apart.

Portability is narrower than access: strictly it covers data provided by the
subject under consent or contract. The export deliberately does not try to draw
that line — it returns everything, which over-delivers on Art. 20 and satisfies
Art. 15 in the same file.

### Art. 21 — Objection

The processing a visitor might object to is the continued publication of their
comment under legitimate interests. The mechanism is Art. 17 with **redact
bodies** ticked. There is no partial opt-out — a comment is either published or
it is not.

Objection to notification email is not an Art. 21 matter: that is consent
withdrawal, and the unsubscribe link handles it.

### Art. 7 — Consent withdrawal

One click in any notification email. Deleting the subscription is immediate and
takes queued digest rows with it.

### Art. 8 — Children

Garrul has no age gate and does not ask for a date of birth, so it cannot
enforce a minimum age. If your audience may include children below your member
state's digital-consent age (13–16 depending on the country), that is a policy
and moderation problem, not one the software solves. Say so in your policy — the
template does — and be prepared to erase on a parent's request, which is the
same Art. 17 path.

### Art. 33/34 — Breach notification

72 hours from becoming aware, to your supervisory authority, and to affected
subjects where the risk is high. The operational runbook — what a D1 dump
exposure actually means, and what to do first — is in
[`../../AGENTS-OPERATE.md`](../../AGENTS-OPERATE.md) §11, *Personal-data
breach*.

The single highest-impact fact: a leaked `IP_HASH_SECRET` together with a D1
dump is an **IP address disclosure**, not a hash disclosure. The construction is
unsalted and IPv4 is a 2³² input space, so anyone holding both can rebuild every
address. Assess the pair accordingly. [`../ip-hashing.md`](../ip-hashing.md).

### Art. 30 — Records of processing

[`data-inventory.md`](data-inventory.md) is written to be pasted into a ROPA:
one row per store, with purpose, basis, retention and recipients.

### Art. 32 — Security of processing

What ships on by default: HTTPS only, `HttpOnly`/`Secure`/`Partitioned` session
cookie, no raw IPs anywhere, an `Origin` allowlist on every state-changing
route, a strict markdown allowlist with no raw HTML, hashed IPs via a single
entry point, and rate limiting on the write paths. What is yours: keeping
`IP_HASH_SECRET` and the D1 dumps out of anywhere they can leak, and limiting
who holds an admin account.

---

## Retention

The GDPR wants a defined period, not "indefinitely". Garrul gives you three
dials and one fixed window:

| Data | Control | Default |
| --- | --- | --- |
| `comments.ip_hash`, `reports.reporter_ip_hash` | `IP_HASH_RETENTION_DAYS` (min 7, max 3650) | **Off** — kept forever |
| `audit_log` rows | `AUDIT_LOG_RETENTION_DAYS` (min 30, max 3650) | **Off** — kept forever |
| `webhook_deliveries` | none — fixed | **30 days**, always |
| Sessions | none — fixed | 30 days, sliding |

Both retention dials default to off deliberately: an upgrade must never start
deleting an operator's history on its first cron tick. That means **the defaults
are the least compliant setting**, and choosing a window is your job. Set them
in `wrangler.toml` (or Settings → Privacy), watch them work at
`/admin/operator`, and drain a backlog there on demand.

Neither sweep ever expires `users.provider_id` for `provider='anon'` rows,
because for a signed-out visitor that hash *is* the account. Expiring it would
delete anonymous identities, not hashes.

---

## Known limitations

Real gaps in this version. Put them in your risk assessment; tell a requester
about the ones that affect them.

1. **An email address cannot be rectified in place (Art. 16).** `users.email` is
   written once, at account creation, and never refreshed from the provider
   (`src/db/queries.ts:364-380`). This is deliberate and will not be "fixed": a
   compromised or relaxed provider that could rewrite the stored address would
   gain a privilege-escalation path, because `ADMIN_EMAILS` and subscription
   matching both key on it. The available routes are an operator UPDATE against
   D1, or erasure followed by a fresh sign-in. Tell the requester which you did.

2. **A copy of an erased comment can survive up to 30 days in
   `webhook_deliveries.payload`.** Erasure does not reach that table. It is
   pruned unconditionally at 30 days (`src/lib/webhook.ts:360`), so the window is
   bounded — but it is not zero. If you cannot accept it, don't run webhooks, or
   clear the table after processing an erasure.

3. **No self-serve account deletion.** Erasure is admin-mediated: the subject
   emails you and you run it. That satisfies Art. 17, which sets no requirement
   for a self-service button, but it does mean your response time is manual.
   Self-serve deletion is a tracked v2 item.

4. **No age verification (Art. 8).** No gate, no date of birth, no
   parental-consent flow.

5. **`audit_log.reason` is free text and is exported.** A moderator can type a
   third party's name into it. Skim it before releasing a file.

6. **Erasure does not touch `votes`, `reactions`, `page_votes`,
   `page_reactions`.** They hold nothing but a link to a now-anonymous account.
   Deleting them would silently restate every score the thread has been showing,
   which is a worse outcome than a pseudonymous row. Defensible, but state it if
   a requester asks for "everything".

7. **`ip_hash` is a pseudonym, not anonymisation.** Recital 26 territory: it is
   personal data, it stays personal data, and against someone holding
   `IP_HASH_SECRET` it is reversible by brute force. Treat any export containing
   one as containing an IP address. [`../ip-hashing.md`](../ip-hashing.md).

## See also

- [`data-inventory.md`](data-inventory.md) — what is stored, where, for how long
- [`dsar-runbook.md`](dsar-runbook.md) — the operational steps per request type
- [`ccpa.md`](ccpa.md) — the US-side obligations over the same data
- [`subprocessors.md`](subprocessors.md) — recipients, for Art. 15(1)(c)
- [`../privacy-policy.template.md`](../privacy-policy.template.md) — a policy to edit
