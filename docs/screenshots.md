# Screenshots

A visual tour of the reader-facing widget and the admin UI.

> Screenshots reflect **v2.5.1** and may lag the current UI. They are
> regenerated from seeded demo data, not from a live instance — every name,
> avatar, comment, email address and webhook URL below is invented.

## The widget

What your readers see. The widget renders inside a Shadow DOM, so the host
page's CSS can't leak in and Garrul's can't leak out. Colors come from CSS
variables — see [`THEMING.md`](THEMING.md).

### Light

![Garrul comment widget on a light host page, showing the page reaction bar, the comment composer with a markdown toolbar, and a threaded discussion](screenshots/widget-light.png)

### Dark

Follows the host page's `prefers-color-scheme` by default, or force it with
`data-theme`.

![The same discussion rendered in dark mode](screenshots/widget-dark.png)

### Mobile

![The widget at a 390px viewport, with the reaction bar, composer and a comment containing a fenced code block that scrolls within its own box](screenshots/widget-mobile.png)

Long lines in fenced code blocks scroll inside the block rather than widening
the host page.

## Admin UI

Server-rendered HTML with Alpine.js for interactivity — no SPA bundle. Reachable
at `/admin` for signed-in users listed in `ADMIN_EMAILS`.

### Dashboard

Counts at a glance, your embed snippet ready to copy, and a 30-day comment
volume chart.

![Admin dashboard showing total/pending/spam comment counts and user count, the embed snippet, and a comments-per-day chart](screenshots/admin-dashboard.png)

### Moderation queue

The default view is everything awaiting a decision. Approve, spam, or delete
inline; filter by status or host.

![Moderation queue filtered to pending comments, each row showing author, body, metadata and action buttons](screenshots/admin-queue-pending.png)

Switch to approved comments to browse or retro-moderate published threads:

![Moderation queue filtered to approved comments](screenshots/admin-queue.png)

What the spam filter caught, so you can spot false positives:

![Moderation queue filtered to comments marked as spam](screenshots/admin-queue-spam.png)

Reader reports cut across statuses — a reported comment may already be
approved:

![Moderation queue filtered to reader-reported comments, showing the report reason](screenshots/admin-queue-reported.png)

### Comment detail

Full context for one comment: the rendered body and its raw markdown, the reader
reports against it, its replies, and the author's five most recent other
comments — enough to judge a report without leaving the page. Actions run from
spam/delete through to banning the author or dismissing the reports.

![Comment detail page showing the rendered comment, its raw markdown, reader reports, replies, other comments by the same author, and moderation actions](screenshots/admin-comment-detail.png)

### Users

Everyone who has commented, with their provider, comment count, and ban
controls.

![User list showing display names, sign-in providers, comment counts and per-user actions](screenshots/admin-users.png)

### Audit log

Every moderation action, who performed it, and when. Append-only.

![Audit log listing moderation actions with actor, target and timestamp](screenshots/admin-audit.png)

### Settings

Feature toggles, display options and moderation rules, resolved from defaults +
KV overrides. A toggle here overrides the matching env var without a redeploy;
"Reset to defaults" clears the overrides again. Grouped into tabs — the Features
tab is shown here.

![Settings page, Features tab, with toggles for accepting comments, per-comment emoji reactions, comment votes, downvotes, page reactions, page votes and deleted-comment placeholders](screenshots/admin-settings.png)

### Webhooks

Outbound endpoints, the events each subscribes to, and their delivery health.
Failed deliveries retry with exponential backoff for ~9 hours; an endpoint that
gives up 10 in a row is auto-paused, as the middle row shows. See
[`webhooks.md`](webhooks.md).

![Webhooks page listing three endpoints — Slack, generic and Discord — with their subscribed events and creation dates, one of them marked auto-paused after 10 failed deliveries](screenshots/admin-webhooks.png)

### Saved replies

Canned moderator responses, insertable when replying from the queue.

![Saved replies list showing reusable moderator response templates](screenshots/admin-saved-replies.png)

### Subscriptions

Who is subscribed to replies on which post, and whether they've confirmed.

![Subscriptions list showing subscriber email, post and confirmation state](screenshots/admin-subscriptions.png)

### Operator

One-off maintenance jobs: re-render stored comment HTML after a sanitizer
change, inspect IP-hash retention, seed a demo post, and import a Disqus export.
Each panel reports current state first — here, all 134 comments are already at
renderer version 2, so the rerender is a no-op.

![Operator page showing the rerender, IP-hash retention, seed-demo-post and Disqus import panels, each with its current status](screenshots/admin-operator.png)

## Regenerating these

There's no committed harness for this — the screenshots are produced ad hoc
against a local `wrangler dev` instance seeded with invented data, then
downscaled to 1× and quantized to a 256-colour palette to keep the repo light.

Two things to preserve if you reshoot them:

- **Never capture Settings → Configuration.** That tab renders live env values
  (`ALLOWED_ORIGINS`, `ADMIN_EMAILS`, and similar). Only the Features tab is
  safe to publish.
- **Use seeded data, never a real instance.** Blurring production screenshots
  is not a substitute; a blur that misses one character leaks a live secret.
