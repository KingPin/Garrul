# CCPA / CPRA: categories, rights, and the "we don't sell" position

**You are the business.** If the CCPA applies to you — broadly, a for-profit
business doing business in California that meets one of the revenue, volume or
data-sale thresholds — the obligations are yours. Garrul is a tool you run; it is
neither a business nor a service provider in the statutory sense, and this doc
does not claim it "is CCPA compliant".

**Not legal advice.** This translates what the code stores into the statute's own
vocabulary, so your notice-at-collection and your response to a consumer request
can be specific instead of hedged. Whether the Act applies to you at all is your
call.

Read [`data-inventory.md`](data-inventory.md) first — this is that inventory
recategorised, not a second source of truth.

---

## Categories of personal information collected

The statutory list is § 1798.140(v)(1)(A)–(K). Only these apply:

| Category | Collected? | What, specifically |
| --- | --- | --- |
| **(A) Identifiers** | Yes | Display name, email address (OAuth or subscription), account ID (ULID), provider user id, and a **hashed** IP address. No raw IP is ever stored or logged. |
| **(B) Customer records** (Civ. Code § 1798.80(e)) | Partly | Name and email overlap with (A). No address, phone, financial or insurance data. |
| **(C) Protected classifications** | No | Never asked, never inferred. |
| **(D) Commercial information** | No | No purchases, no transactions, no consideration of any kind. |
| **(E) Biometric information** | No | — |
| **(F) Internet / network activity** | Yes | Browser user-agent string, and the comment content the consumer chose to publish. **No** browsing history, search history, or interaction with other sites — the widget sets no tracking cookie and loads no analytics. |
| **(G) Geolocation data** | No | The hashed IP is not resolved to a location. Cloudflare's own edge logs are Cloudflare's, under its own notice. |
| **(H) Sensory data** | No | — |
| **(I) Employment information** | No | — |
| **(J) Education information** | No | — |
| **(K) Inferences** | Arguably | A spam/ham classification is recorded per comment (`spam_verdicts`). It is a content judgement, not a profile of the person, and it is never used to characterise them — but disclose it rather than argue about it. |

### Sensitive personal information (CPRA § 1798.140(ae))

**None is collected.** No government identifiers, no precise geolocation, no
racial or ethnic origin, no religious beliefs, no union membership, no genetic or
biometric data, no health or sex-life data, and no contents of mail or messages
other than the comment the consumer deliberately published.

That has a useful consequence: the **right to limit the use of sensitive PI**
(§ 1798.121) has nothing to operate on. Say so explicitly in your notice rather
than omitting the section — a missing heading reads as an oversight.

### Sources, and purposes

- **Sources**: the consumer directly (comment text, name, subscription address),
  and their OAuth provider if they chose to sign in (name, email, avatar,
  provider user id). Nothing is bought, scraped, or received from a data broker.
- **Business purposes** (§ 1798.140(e)): publishing and attributing the comment;
  preventing spam and abuse; sending the notifications they asked for;
  maintaining an accountability record of moderation.

---

## "We do not sell or share" — and why you can defend it

Under CCPA, a **sale** is a disclosure for monetary *or other valuable*
consideration; under CPRA, **sharing** is a disclosure for cross-context
behavioural advertising. Garrul does neither, and the reason is structural rather
than a promise:

- **There is no advertising machinery.** No ad tags, no pixels, no third-party
  scripts, no identity graph, no audience export. The widget's only outbound
  request is to your own Worker.
- **There is no analytics.** Nothing measures a reader.
- **Every third party that receives data is a service provider under contract**,
  acting only on your instructions for the purpose you engaged them for — email
  delivery, spam scoring, chat notification. That is precisely the
  § 1798.140(ag)(2)(C) carve-out from "sale":  a transfer to a service provider
  is not a sale.
- **The one transfer that could become a sale is one you configure**: an outbound
  webhook to an endpoint of your choosing. If that endpoint is an analytics or
  ad-tech vendor rather than a service provider under contract, *your* deployment
  discloses for consideration and this section stops being true for you. See
  [`subprocessors.md`](subprocessors.md).

Because there is no sale or share, you do not need a **"Do Not Sell or Share My
Personal Information"** link for the comment system, and the under-16 opt-in
regime (§ 1798.120(c)) has nothing to attach to. State the conclusion *and* the
reasoning in your notice — a bare "we do not sell your data" is what everyone
writes; the reasoning is what survives a question.

No **financial incentive** is offered for personal information
(§ 1798.125(b)), so no incentive notice is required.

---

## Consumer rights

### Right to know / access (§ 1798.100, § 1798.110, § 1798.115)

`GET /admin/api/users/:id/export`, or the **Export personal data** panel on the
user's page in the admin UI. Returns one JSON file: profile, comments, reports
filed, subscriptions matching their address, votes, reactions, page engagement,
Telegram link, spam classifications, and moderation actions taken against them.

Three things the export does *not* answer, which you must:

- **Categories, sources, purposes, and third parties** — that is this document
  plus [`subprocessors.md`](subprocessors.md), not the file.
- **Whether you sold or shared it** — you didn't; say so.
- **The identity of moderators.** `audit_log.admin_id` is deliberately excluded:
  it is another person's identifier, and § 1798.130(a)(5)(B)'s carve-out for
  information about other individuals covers it.

### Right to delete (§ 1798.105)

**Admin → user page → Erase user data.** See
[`gdpr.md`](gdpr.md#art-17--erasure) for exactly what it clears; the mechanism is
identical.

Note the statutory exceptions that let you keep a comment body with the author
anonymized: § 1798.105(d)(4) (exercise of free speech, including another
consumer's right to it) and (d)(2)/(d)(3) for security and integrity. The **redact
bodies** option is there for when the personal information is *in the text* and
those exceptions don't cover it.

### Right to correct (§ 1798.106, CPRA)

Display name and avatar refresh from the OAuth provider on the consumer's next
sign-in. Comment text is editable by its author inside `EDIT_WINDOW_MINUTES`.
**Email cannot be corrected in place** — see *Known limitations*.

### Right to opt out of sale/sharing (§ 1798.120)

Nothing to opt out of. See above.

### Right to limit sensitive PI (§ 1798.121)

Nothing to limit. No sensitive PI is collected.

### Right to non-retaliation (§ 1798.125)

Nothing in the software conditions participation on data. A consumer can comment
anonymously without signing in, and can decline notifications.

---

## The 12-month lookback, and CPRA's extension

§ 1798.130(a)(2) requires disclosure covering the 12 months preceding the
request. The export is **not time-bounded** — it returns every row, whatever its
age, which over-delivers on the 12-month floor and also covers CPRA's
"beyond 12 months" entitlement (§ 1798.130(a)(3)(B)(iii)) without you having to
argue about disproportionate effort.

The one wrinkle runs the other way: if you set `IP_HASH_RETENTION_DAYS` or
`AUDIT_LOG_RETENTION_DAYS`, an export can legitimately hold *less* than 12
months of those fields, because they were deleted on schedule. Deleting on a
published retention schedule is not a failure to disclose — but say in your
notice that you do it, and to what.

---

## Verification and response deadlines

**Garrul does not verify identity.** There is no consumer-facing request flow at
all; a request arrives by email and an admin acts on it. Verification is entirely
yours, and it matters more here than the statute's text suggests: the export
contains an `ip_hash`, and handing one to the wrong person is a disclosure about
whoever really owns that account.

Reasonable practice for a comment system:

- **Signed in with OAuth** — have them prove control of the provider account,
  e.g. reply from the email on file, or post a comment containing a nonce you
  give them.
- **Email subscription only** — a confirmation round-trip to the address on file
  is exactly proportionate; the address *is* the account.
- **Anonymous commenter** — you often cannot verify them at all. § 1798.145(j)
  contemplates that: if you cannot verify, deny the request and say why. Do not
  guess from an IP hash.

Deadlines: acknowledge within 10 business days, substantively respond within 45
calendar days, extendable by another 45 with notice. Track it yourself — nothing
in the software does.

---

## Known limitations

1. **No notice-at-collection is rendered by the widget.**
   § 1798.100(a) requires notice at or before the point of collection, and the
   comment form does not display one. **You must put it on the host page** — a
   line near the comment form linking to your privacy policy. Nothing in Garrul
   does this for you, and it is the single most likely gap in a deployment.

2. **No email correction path.** `users.email` is written once and never
   refreshed, deliberately: an address that a relaxed provider could rewrite
   would be a privilege-escalation path, because `ADMIN_EMAILS` and subscription
   matching key on it. Correction means an operator UPDATE against D1, or
   erasure plus a fresh sign-in.

3. **No consumer-facing request mechanism.** No web form, no toll-free number
   (§ 1798.130(a)(1) — a business operating exclusively online and with a direct
   relationship need only provide an email address, which most deployments will
   rely on). Requests arrive by email; an admin acts on them.

4. **No verification tooling, and no request log.** Neither the verification you
   performed nor the response you sent is recorded anywhere — except that running
   the export writes a `user.export` audit row with **counts only**, never the
   values. Keep your own record of who asked, what you checked, and what you
   sent.

5. **A copy of a deleted comment can survive up to 30 days** in
   `webhook_deliveries.payload`, which erasure does not reach. Pruned
   unconditionally at 30 days (`src/lib/webhook.ts:360`).

6. **Whether a spam verdict is an "inference" is genuinely unsettled.** The
   inventory calls it arguable rather than picking a side. Disclosing it costs
   nothing; omitting it and being wrong costs something.

## See also

- [`data-inventory.md`](data-inventory.md) — the field-level source of truth
- [`gdpr.md`](gdpr.md) — the EU-side obligations over the same data
- [`subprocessors.md`](subprocessors.md) — service providers, and the webhook caveat
- [`dsar-runbook.md`](dsar-runbook.md) — the operational steps per request type
- [`../privacy-policy.template.md`](../privacy-policy.template.md) — a policy to edit
