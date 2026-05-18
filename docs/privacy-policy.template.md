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
  for rate limiting and (if applicable) anonymous-author identity.
- A **timestamp**.

If you signed in with **OAuth** (GitHub or Google), we additionally
store:

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
- **Hashed IP**: retained for the lifetime of the comment.
- **OAuth account data**: until you ask us to remove it.
- **Subscriptions**: until you click the unsubscribe link in any
  notification email.

## Cookies

We set one cookie, `garrul_sess`, on the comments subdomain
`[comments.yourdomain.com]`. It's:

- **HttpOnly** — JavaScript can't read it.
- **Secure** — only sent over HTTPS.
- **SameSite=None; Partitioned** — scoped per top-level site so we
  comply with Chrome's third-party cookie phase-out and Safari ITP.
- 32 random bytes; its only role is to look up your session in our
  database.

No advertising, analytics, or tracking cookies are set.

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

Email `[YOUR EMAIL]` and we'll remove your comments, account, and
subscriptions within a reasonable timeframe.

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
