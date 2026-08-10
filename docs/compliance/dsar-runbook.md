# DSAR runbook

What to actually do when someone emails you asking for their data. Written for
the person holding the admin session, not for a lawyer.

**Garrul has no consumer-facing request flow.** There is no web form, no
"download my data" button for the commenter, and no identity verification. A
request arrives however you publish it — an email address in your privacy policy
is what most deployments use — and an admin acts on it by hand. That means every
step below is yours: verify, locate, respond, and keep the record.

Not legal advice. The deadlines and article references are here so you can act
without re-reading [`gdpr.md`](gdpr.md) and [`ccpa.md`](ccpa.md) mid-request.

---

## Clock

| Regime | Acknowledge | Substantive response | Extension |
| --- | --- | --- | --- |
| GDPR (Art. 12(3)) | — | **1 month** from receipt | +2 months for complex requests, if you tell them inside the first month and say why |
| CCPA (§ 1798.130) | **10 business days** | **45 calendar days** | +45 days with notice |

Nothing in the software tracks this. Start a note the day the request lands.

---

## Step 1 — Verify the requester

Do this **first**, before you look anything up. An export contains an `ip_hash`
and a user-agent string; handing one to the wrong person is a disclosure about
whoever really owns that account, and it is the worst failure mode in this
runbook.

| Who they are | What's proportionate |
| --- | --- |
| **Signed in with OAuth** | Prove control of the provider account: reply from the email on file, or post a comment containing a nonce you give them, then check the comment's author id matches. |
| **Email subscriber only** | A confirmation round-trip to the address on file. The address *is* the account here, so replying from it is sufficient. |
| **Anonymous commenter** | Usually **not verifiable at all.** You have a display name they typed and a hashed IP. GDPR Art. 12(6) lets you ask for more information; CCPA § 1798.145(j) lets you deny an unverifiable request outright. Say so plainly and stop. |

Never verify from an IP hash — you cannot check it against a claim without the
claimant's raw IP, and matching one only proves they are on the same connection.

**Do not over-collect.** Asking an anonymous commenter for a photo ID to prove
they wrote three comments is itself a privacy problem.

## Step 2 — Locate them

- **Admin → Users**, search box matches **name or email**.
- **Anonymous accounts have no email**, so the name is all you have. Easier
  route: find one of their comments in the queue or on the thread and open the
  author from there.
- **Email-only subscribers have no user row at all.** They live in
  **Admin → Subscriptions**, searchable by address. There is no user page for
  them and no export — see *Email-only subscribers* below.

If they have more than one account (a different OAuth provider, or anonymous
comments *plus* a signed-in history), each account is separate. Ask which they
mean, or handle each and say what you did.

---

## By request type

### Access (GDPR Art. 15) and portability (Art. 20) — "send me my data"

**Admin → Users → their page → *Export personal data…* → Download JSON.**
Or `GET /admin/api/users/:id/export` directly. Admin-only; the file downloads as
`garrul-export-<id>.json`.

You get one JSON object: `export_version`, `exported_at`, then `user`,
`comments`, `reports_filed`, `subscriptions`, `telegram_links`, `votes`,
`reactions`, `page_votes`, `page_reactions`, `spam_verdicts`, and
`moderation_actions`.

**Before you send it:**

1. **Skim `moderation_actions[].reason`.** That's `audit_log.reason` — free text a
   moderator typed. Nothing stops it naming a third party. Redact if it does.
2. **Know what's in `comments`.** Each row carries `ip_hash` and `user_agent`.
   Included deliberately — they are the subject's own data — but it makes the file
   as sensitive as a database extract. Treat it like one.
3. **Don't attach a plaintext dump to an unverified thread.** A password-protected
   archive, or a link they authenticate to, is proportionate to what's inside.

**What the export does *not* answer**, and you must, in the covering message:

- Purposes, categories, recipients, retention, and the source of the data
  (Art. 15(1)) — that's your privacy policy plus
  [`subprocessors.md`](subprocessors.md).
- Whether you sold or shared it (CCPA) — you didn't; say so, and say why.
- **Who moderated them.** `admin_id` is deliberately excluded: it is another
  person's identifier, and Art. 15(4) / § 1798.130(a)(5)(B) do not require
  disclosing it. If they push, that's the answer.

Running an export writes a `user.export` audit row recording **row counts only**,
never the values — so you have a record that it happened without a second copy of
the data.

### Rectification (Art. 16) / correction (§ 1798.106) — "this is wrong"

| Field | What to do |
| --- | --- |
| **Display name, avatar** | Nothing. Tell them to fix it at their OAuth provider and sign in again — both refresh on every login. |
| **Comment text** | The author can edit their own comment inside `EDIT_WINDOW_MINUTES` (default 15). Past that, you edit it for them. |
| **Email address** | **No in-product path.** See below. |

**The email limitation, and what to tell them.** `users.email` is written once at
account creation and never refreshed — deliberately, because an address that a
provider could rewrite would be a privilege-escalation path (`ADMIN_EMAILS` and
subscription matching both key on it). Your two options:

- An operator `UPDATE` against D1, which you should be comfortable doing by hand
  and should log; or
- erasure followed by a fresh sign-in, which gives them a **new account** —
  their old comments stay, anonymized, and do not follow them.

Explain which one you did. "We corrected it" and "we deleted the old account"
are very different answers to receive.

### Erasure (Art. 17) / deletion (§ 1798.105) — "delete me"

**Admin → Users → their page → *Erase personal data…*** Type `ERASE`, then
confirm. Irreversible and audit-logged. What it clears is listed in
[`gdpr.md`](gdpr.md#art-17--erasure).

Three things that trip people up:

- **It refuses on another admin, and on yourself.** Erasure clears the
  `provider_id` their next login is matched on, so **demote the account to user
  first**, then erase. The button isn't offered when it would only 400.
- **Comment bodies are kept by default**, author anonymized, so the thread stays
  readable — the Art. 17(3)(a) / § 1798.105(d)(4) free-expression carve-out. Tick
  **"Also blank their comment bodies and mark them deleted"** when the personal
  data is *in the text*: a name, an address, an employer. Author-level scrubbing
  never reaches that.
- **A copy can survive up to 30 days** in `webhook_deliveries.payload` if you run
  webhooks. Bounded and automatic (`src/lib/webhook.ts:360`), but not zero — if
  the request is sensitive, clear that table afterwards.

Then reply. Note that **votes, reactions and scores are left in place** — they
hold nothing but a link to a now-anonymous account, and removing them would
silently restate every score the thread has been showing. Say so if they asked
for "everything".

### Objection (Art. 21) — "stop publishing my comment"

There is no partial opt-out; a comment is either published or it is not. The
mechanism is erasure with **redact bodies** ticked. If they only object to
*attribution*, plain erasure already anonymizes the author.

### Consent withdrawal (Art. 7) — "stop emailing me"

They can do it themselves: the unsubscribe link is in every notification.
If they ask you, **Admin → Subscriptions → search their address → Unsubscribe.**
Note this is a **soft** mark — it stops the email but keeps the row, and the
address with it. To remove the address as well, see below.

### Opt out of sale/sharing (§ 1798.120)

There is nothing to opt out of, and the reasoning is in
[`ccpa.md`](ccpa.md#we-do-not-sell-or-share--and-why-you-can-defend-it). If you
configured a webhook to an ad-tech or analytics recipient, that answer changes
for your deployment — check before you send it.

---

## Email-only subscribers

Somebody who subscribed to a thread without ever signing in has **no user row**.
Their data is one `subscriptions` row (address, tokens, post slug) plus any queued
`notifications`. Consequences:

- **The export doesn't apply.** Answer an access request in prose — you hold their
  email address, which posts they follow, and when they subscribed. That's the
  whole of it.
- **Admin "Unsubscribe" is not deletion.** It sets `unsubscribed_at` and leaves
  the address. Deleting the address is SQL:

  ```bash
  npx wrangler d1 execute garrul-db --remote --command \
    "DELETE FROM notifications WHERE subscription_id IN (SELECT id FROM subscriptions WHERE email = 'them@example.com')"
  npx wrangler d1 execute garrul-db --remote --command \
    "DELETE FROM subscriptions WHERE email = 'them@example.com'"
  ```

  Notifications first — they reference the subscription. Nothing audit-logs this,
  so record it yourself.

If the same address also belongs to an account, `eraseUser` deletes the matching
subscription rows for you; you only need the SQL when there is no account.

---

## Step 3 — Record what you did

Nothing in Garrul keeps a request log. The only trace is a `user.export` or
`user.erase` audit row, and neither records who asked or what you checked. Keep
your own note per request:

- date received, date responded
- what identity check you performed, and what satisfied you
- exactly what you sent or cleared, and what you withheld and why
- if you denied it, the ground (unverifiable, exception relied on)

That note is your Art. 5(2) accountability evidence and your § 1798.130 record.
It matters most in the case you'd least like to be in.

---

## Reply skeleton

Adapt; don't paste verbatim.

> We received your request on **[date]** and have verified your identity by
> **[method]**.
>
> Attached is every piece of personal data we hold about your account, exported
> from our comment system. It includes your profile, your comments, hashed IP
> addresses and browser user-agent strings recorded with them, any reports you
> filed, email subscriptions for your address, and moderation actions concerning
> your account. Where a moderation action was taken, we have not included which
> member of our team took it, as that is their personal data.
>
> We collect this data to publish and attribute comments, prevent spam and abuse,
> and send the notifications you asked for. We do not sell or share personal
> information, and we use no advertising or analytics tracking. The third parties
> that process this data on our behalf are listed at **[link to your policy]**.
>
> [Retention: how long you keep hashed IPs and moderation records.]
>
> If anything is inaccurate, or you would like it erased, reply and we will act
> within one month.

## See also

- [`gdpr.md`](gdpr.md) — the articles behind each step
- [`ccpa.md`](ccpa.md) — verification standards and deadlines, US side
- [`data-inventory.md`](data-inventory.md) — what is stored where, if a requester asks something this runbook doesn't cover
- [`subprocessors.md`](subprocessors.md) — the recipient list your reply needs to point at
- [`../ip-hashing.md`](../ip-hashing.md) — before you treat an exported hash as anonymous
