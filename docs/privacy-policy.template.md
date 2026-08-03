# Privacy Policy

_Last updated: [DATE]_

This template covers a typical Garrul deployment. Edit it for your site
before publishing. Items in `[brackets]` are placeholders.

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

  <!-- Keep the sentence that matches your instance. Garrul's
       IP_HASH_RETENTION_DAYS setting is OFF by default: if you haven't set
       it, the first sentence is the true one. If you have, use the second
       and fill in your window — and note that it deliberately says
       "comments and abuse reports", not "everything". The anonymous
       identity is never expired on a timer, because for a signed-out
       visitor that hash *is* the account. Claiming otherwise would be
       false. See docs/ip-hashing.md. -->

  There is no automatic expiry.

  We automatically erase the hashed IP stored against comments and abuse
  reports after **[90] days**. The anonymous identity derived from it is
  kept for as long as the account exists, because it is what lets you be
  recognised as the same commenter when you return.
- **OAuth account data**: until you ask us to remove it.
- **Subscriptions**: until you click the unsubscribe link in any
  notification email.

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

We do not sell or share comment data with any other third party.

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
