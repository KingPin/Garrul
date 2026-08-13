# Privacy Policy

_Last updated: [DATE]_

This template covers a typical Garrul deployment. Edit it for your site
before publishing. Items in `[brackets]` are placeholders.

<!-- Before publishing, read docs/compliance/. data-inventory.md lists every
     field this policy is describing; subprocessors.md tells you which of the
     "Who sees your data" entries below actually apply to YOUR configuration
     (a default instance has only Cloudflare). Several sections here are
     written for the defaults and are WRONG if you turned something on —
     each one says so in a comment like this. -->

<!-- Also: this policy is not a notice-at-collection. CCPA § 1798.100(a) and
     GDPR Art. 13 want notice at or before the point of collection, and the
     comment widget renders none. Put a line near the comment form on your
     own pages linking here. -->


---

This privacy policy explains what data the comment system on `[YOUR
DOMAIN]` collects, how it's used, and how to remove it.

## What we collect

When you post a comment, the following is stored:

- The **name** you provide (or the display name from your OAuth
  provider if you signed in).
- The **text of your comment**.
- A **hashed IP address** — we apply HMAC-SHA-256 with a per-site secret
  to your IP before storing. We never store the raw IP. The hash is used
  for rate limiting, duplicate-report detection and (if applicable)
  anonymous-author identity. IPv6 addresses are shortened to their
  network prefix before hashing, so the hash identifies a network rather
  than a single device.
- Your browser's **user-agent string**, as sent with the request. It is
  stored next to the hashed IP and used for the same purpose: spotting
  spam and abuse.
- A **timestamp**.

If you signed in with **OAuth** (GitHub, Google, Facebook, X, or
Discord), we additionally store:

- Your **email address** as returned by the provider (we never read
  your inbox or anything else from the provider).
- Your **avatar URL**.
- The **provider's user ID** (so re-sign-in finds the same account).

If you opted in to **email notifications**:

- Your **email address** and an opaque **unsubscribe token**.

If you reacted to a comment, we store the **(your-user-id,
comment-id, reaction-kind)** tuple.

## What we don't collect

- Tracking pixels, analytics scripts, third-party advertising tags.
- Your raw IP address.
- Anything from your OAuth provider beyond your name, email, and
  avatar.

## How long we keep it

- **Comments**: retained indefinitely unless you ask us to delete
  them. Soft-deleted comments are kept (showing as `[deleted]`) so
  reply chains remain intact.
- **Hashed IP**: retained for the lifetime of the row it belongs to —
  the comment (including after a soft delete), any abuse report you
  file, and the anonymous identity we derive from it if you comment
  without signing in. It is removed if you ask us to erase your data
  (see below).

  There is no automatic expiry.

  <!-- The sentence above matches a default Garrul instance, where
       IP_HASH_RETENTION_DAYS is OFF. If you have set it, delete that
       sentence and use this paragraph instead, filling in your window:

  We automatically erase the hashed IP stored against comments and abuse
  reports after **[90] days**. The anonymous identity derived from it is
  kept for as long as the account exists, because it is what lets you be
  recognised as the same commenter when you return.

       Note it deliberately says "comments and abuse reports", not
       "everything". The anonymous identity is never expired on a timer,
       because for a signed-out visitor that hash *is* the account.
       Claiming otherwise would be false. See docs/ip-hashing.md. -->
- **Browser user-agent**: kept and removed on exactly the same terms as
  the hashed IP above.
- **OAuth account data**: until you ask us to remove it.
- **Subscriptions**: until you unsubscribe. You can do that from your mail
  client's own Unsubscribe button, from the link in any notification email
  (that link's page also lists every other thread you follow, and can drop
  all of them at once), or — if you signed in with a provider that gave us
  a verified address — from the 🔔 and **Manage subscriptions** controls in
  the comment widget itself.
- **Moderation records**: when we approve, hide, delete or ban, we keep a
  record of the action, the reason, the account it concerned and when —
  so we can explain a moderation decision later. These records are kept
  indefinitely and are **not** removed by an erasure request, because
  they document what we did rather than who you are. They contain no
  email address and no display name.

  <!-- Accurate for a default instance, where AUDIT_LOG_RETENTION_DAYS is
       OFF. If you have set it, replace "kept indefinitely" with your
       window, e.g. "kept for 365 days and then deleted automatically". -->
- **Notification delivery log**: when we forward a new comment to our own
  moderation tools, a copy of that message — which includes the comment
  text and the author's display name — is kept so a failed delivery can be
  retried. It is deleted automatically after **30 days**, and this is the
  one place a copy of a comment can briefly outlive an erasure request.

  <!-- This is webhook_deliveries. Delete this bullet if you have no webhook
       endpoints configured. The 30-day prune is fixed in code, always on,
       and not configurable; erasure does not reach this table. -->


## Cookies

We set one cookie, `__Host-garrul_sess`, on the comments subdomain
`[comments.yourdomain.com]`. It's:

- **HttpOnly** — JavaScript can't read it.
- **Secure** — only sent over HTTPS.
- **SameSite=None; Partitioned** — scoped per top-level site so we
  comply with Chrome's third-party cookie phase-out and Safari ITP.
- 32 random bytes; its only role is to look up your session in our
  database.

No advertising, analytics, or tracking cookies are set.

## Local browser storage

While you are typing, an unsent comment draft is saved in your own
browser's `localStorage` so it survives an accidental reload. It never
leaves your device — it is not sent to us — and it is cleared as soon as
you submit or cancel the comment.

## Who sees your data

- **Site moderators** at `[YOUR DOMAIN]` (whose emails are in the
  site's admin list) can view all comments and user records.
- **Cloudflare** hosts the comment system and provides DDoS
  protection. Their privacy policy applies to logs and edge-cache
  data.
- **Resend** (if notifications are enabled) handles email delivery.
  Their privacy policy applies to email contents.

<!-- Everything below is OFF in a default deployment. Delete the entries you
     have not enabled — leaving them in claims a transfer that isn't
     happening, which is its own accuracy problem. Check
     docs/compliance/subprocessors.md against your config. -->

<!--
- **Akismet** (Automattic) checks comments for spam. **Your comment text,
  your display name and your browser user-agent are sent to them.** Your
  email address is not, and neither is your IP address.
  [Enable only if SPAM_PROVIDER=akismet.]

- **Cloudflare Workers AI** classifies comments as spam or not. Your
  comment text is sent to it. This stays inside Cloudflare, who already
  host the comment system.
  [Enable only if SPAM_PROVIDER=workers-ai.]

- **Telegram** receives moderation notifications, which include comment
  text and author display names.
  [Enable only if a Telegram bot is configured.]

- **[NAME THE SERVICE]** receives a copy of each new comment, including
  its text and the author's display name, so our moderation team is
  notified. [Enable only if you have configured a webhook endpoint. Name
  the recipient — you know who it is and we cannot. If it is an analytics
  or advertising vendor rather than a tool acting solely on our
  instructions, the "we do not sell or share" sentence below is no longer
  true for your site.]
-->

**Signing in** with GitHub, Google, Facebook, X or Discord tells that
provider you are using our site. They act on their own behalf when they
do, under their own privacy policy — not on ours.

We do not sell or share comment data with any other third party. There is
no advertising, no analytics and no cross-site tracking in the comment
system, so there is nothing to opt out of.

## How to get a copy of your data

Email `[YOUR EMAIL]`. We can export everything we hold about your account
as a single machine-readable JSON file: your profile, your comments
(including the hashed IP addresses and user-agent strings stored with
them), any abuse reports you filed, your notification subscriptions, your
votes and reactions, and any moderation actions concerning your account.

We will ask you to confirm you are the person the data belongs to before
we send it — for a signed-in account that usually means replying from the
address on file or posting a comment we can match. If you commented
anonymously, we often cannot verify you at all, and in that case we will
tell you rather than send someone else's data.

Which moderator took a given action is not included: that is their
personal information, not yours.

<!-- The export lives at /admin/users/<id> -> "Export personal data". The
     verify-locate-respond procedure is docs/compliance/dsar-runbook.md.
     Read it before answering your first request. -->

## Correcting your data

Your display name and avatar come from your OAuth provider and refresh
every time you sign in — change them there and sign in again. You can edit
your own comment for **[15] minutes** after posting; after that, email us.

We cannot change the email address on an existing account. If it is wrong,
email us and we will either correct it by hand or erase the account so you
can sign in again fresh.

<!-- That limitation is deliberate, not a bug: users.email is written once
     and never refreshed, because admin access and subscription matching key
     on it. See docs/compliance/gdpr.md, Known limitations. -->


## How to delete your data

Email `[YOUR EMAIL]` and we'll erase your account within a reasonable
timeframe. Concretely, that means:

- Your display name, email address, avatar and the provider or hashed-IP
  identifier we matched you on are removed. Your comments then show as
  `[deleted]` with no author.
- The hashed IP and browser user-agent stored against every comment you
  wrote, and against any abuse report you filed, are removed.
- Your email notification subscriptions are deleted, along with any
  linked chat account, and you are signed out everywhere.
- If you sign in again afterwards, you get a **new** account. The erased
  one is not restored.

**Your comment text is kept by default**, without your name attached, so
that conversations other people took part in stay readable. Tell us if
the text itself contains personal information and we'll blank those
comments too.

For most users a simpler option is to delete individual comments
using the trash icon next to your comment (available for 15 minutes
after posting, or indefinitely if you're an admin).

## Children

The comment system is not directed at children under 13. If you are
under 13, do not provide your email address or any personal info.

## Changes

If we change this policy in a material way, we'll note the new "Last
updated" date at the top.

## Contact

Email `[YOUR EMAIL]` with privacy questions.
