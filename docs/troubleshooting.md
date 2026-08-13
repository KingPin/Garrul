# Troubleshooting

## Setup and deploy

### `wrangler deploy` says "Authentication error"

Run `wrangler login` once on this machine. The token lives in
`~/.wrangler/config/default.toml`.

### Migration fails on a fresh D1: "table foo already exists"

Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`). If you see
this, the `_migrations` ledger row got out of sync with the actual
schema — usually because you ran raw SQL against the DB. Resolve by
inspecting `_migrations` and inserting the missing row manually.

### "Worker hit memory/CPU limits"

Most likely: a single post has tens of thousands of comments and the
tree assembly is loading them all into memory. The pagination cap is
100 top-level threads per fetch — but a single thread with thousands
of replies still loads them all. Single-thread pagination is on the
v2 backlog.

## Embedding

### Widget never renders, console shows CORS error

Add the host page's origin to `ALLOWED_ORIGINS`. It's a
comma-separated list of full origins, no trailing slash, no path:

```toml
ALLOWED_ORIGINS = "https://yourblog.example.com,https://staging.example.com"
```

On a fresh install the usual cause is that the line is still the one
`wrangler.example.toml` ships — `https://yourblog.example.com`, which
is nobody's blog. `npm run upgrade -- --dry-run` lists every var still
set to its shipped placeholder.

Cloudflare caches the previous CORS response — redeploy and hard-reload.

### Widget renders but submitting fails with `err.origin.forbidden`

Same fix as above. The CSRF middleware also uses `ALLOWED_ORIGINS`.

### Widget looks unstyled

The Shadow DOM stylesheet is inline in the embed bundle. If the
widget renders but is unstyled, your CSP probably blocks
`style-src 'unsafe-inline'` for the embedded `<style>` tag.

Two options:

1. Add `unsafe-inline` to your CSP for the host page.
2. Use the iframe variant (`/embed/:slug`) instead — it has its own
   CSP and won't touch yours.

### Posting a comment fails with "The anti-spam check didn't load."

The Turnstile (anti-spam) iframe never reported in, so the widget had no
token to submit. The browser console usually shows a CSP violation
referencing the Worker origin, e.g.:

```
Framing 'https://comments.example.com/' violates the following Content
Security Policy directive: "frame-src 'self' ..."
```

The widget renders Turnstile inside a same-origin iframe hosted by
**this Worker** (not by `challenges.cloudflare.com`), so your host CSP
must allow the Worker origin in three directives:

```
script-src  ... https://comments.example.com;
connect-src ... https://comments.example.com;
frame-src   ... https://comments.example.com;
```

`script-src` lets `embed.js` execute, `connect-src` lets it call the
API, and `frame-src` lets it mount the Turnstile-hosting iframe. The
nested challenge frame (at `challenges.cloudflare.com`) lives inside
our iframe — your CSP doesn't see it and doesn't need to allow it.

> Pre-v1.6.0 docs told operators to allow `https://challenges.cloudflare.com`
> in `script-src` / `connect-src` / `frame-src`. After v1.6.0 that's no
> longer needed (and `frame-src` to the Worker origin became required
> instead). The trade is a slightly different host-CSP shape and a
> stricter Garrul-side CSP for the Turnstile iframe.

If you can't relax the host CSP, switch to the iframe variant
(`/embed/:slug`) — the iframe page sets its own CSP that already
permits everything, so the host CSP only needs `frame-src` for the
Worker origin. See the "Iframe (CSP-strict hosts)" section in the
README.

If you intentionally disabled Turnstile by leaving `TURNSTILE_SITE_KEY`
unset, this error shouldn't appear — verify `/api/v1/config` returns
no `turnstile_site_key` and that the widget is loading the current
`embed.js` (Cloudflare caches it for ~24h at the edge).

Two related notes:

- **The Turnstile iframe is not requested until the visitor focuses the
  comment box.** If you are watching DevTools on page load and see no
  request for `/embed/turnstile-frame`, that is expected — click into the
  comment box to trigger it. See [Turnstile mount
  timing](ANTISPAM.md#turnstile-mount-timing).
- **Older instances failed differently.** Before the deferred mount, a
  missing token was submitted anyway and the *server* rejected it with
  "Spam check failed. Refresh and try again." That server error still
  exists but is now hard to reach from the widget, which waits for a token
  and reports the problem itself. If you are seeing the server wording,
  the caller is probably not the current `embed.js`.

## OAuth

### "Sign in" popup opens then closes with no effect

The popup posted a message back, but Safari ITP blocked the cookie
write. Symptoms: callback page loads, popup closes, widget reloads,
user is still signed out.

Fix sequence:

1. Make sure `comments.<yourdomain>` is served over HTTPS with a real
   certificate (no self-signed in production).
2. Make sure the cookie is `SameSite=None; Secure; Partitioned`. This
   is the default in `src/lib/session.ts`. If you've forked and
   changed it, change it back.
3. Visit `https://comments.<yourdomain>` top-level once. Safari ITP
   requires the user to have interacted with the origin in a first-
   party context before allowing partitioned cookies.

If that still fails, the widget falls back to a top-level redirect
when popup is blocked. The user navigates manually back to the blog.

### Popup says "Signed in" but the widget stays signed out until reload

Different failure from the one above: sign-in genuinely worked, and
reloading the page shows the user signed in. The widget just never
found out.

The usual cause is a security header on **your host page**:

```
Cross-Origin-Opener-Policy: same-origin
```

Under COOP, a page with `same-origin` that opens a *cross-origin* popup
puts it in a separate browsing context group. `window.opener` is `null`
inside the popup, so the callback page cannot post `garrul:auth` back —
and it has no way to tell, so it prints "Signed in. You can close this
window." either way. This header ships in most static-host security
presets, so you may have it without having chosen it.

Check with:

```bash
curl -sI https://yourblog.example.com | grep -i cross-origin-opener
```

Fix it on the host page:

```
Cross-Origin-Opener-Policy: same-origin-allow-popups
```

That variant keeps the opener relationship for popups *you* open while
still preventing other origins from getting a handle on your window. It
is the standard value for any site running an OAuth popup.

The widget also recovers on its own, usually within a second of the
popup closing. COOP severs the popup's view of its opener, but not the
opener's handle on the popup — so the widget watches for that window to
close and re-checks `/api/v1/auth/me` when it does (returning focus to
the page triggers the same check).

That recovery only works when the host page and the Worker share a
registered domain (`blog.example.com` + `comments.example.com`), because
the popup's cookie has to be in the same partition. On a genuinely
cross-site embed (`example.com` + `comments.otherdomain.com`) under COOP
there is no way back in — fix the header.

A second, rarer cause: `?return=` didn't match `ALLOWED_ORIGINS`, so the
Worker had no safe `postMessage` target and served the static callback
page instead. Confirm your host origin is listed, scheme and `www.`
included:

```bash
curl -sI https://comments.<yourdomain>/api/v1/health \
  -H "Origin: https://yourblog.example.com" | grep -i access-control-allow-origin
```

No header back means that origin isn't allow-listed.

### "redirect_uri_mismatch" (any provider)

The redirect URI registered in your OAuth app must exactly match
`OAUTH_CALLBACK_BASE` + `/api/v1/auth/<provider>/callback`. No trailing
slash, no `www.` if your worker doesn't serve `www.`. The `<provider>`
path segment is the internal id, which differs from the display name in
one case — X uses `twitter`:

- GitHub → `/api/v1/auth/github/callback`
- Google → `/api/v1/auth/google/callback`
- Facebook → `/api/v1/auth/facebook/callback`
- X → `/api/v1/auth/twitter/callback`
- Discord → `/api/v1/auth/discord/callback`

GitHub OAuth apps allow exactly one callback URL. For staging +
production, register two OAuth apps and switch credentials per
deployment.

First thing to check on a fresh install: that `OAUTH_CALLBACK_BASE` in
`wrangler.toml` is still not `https://comments.example.com`. It is one
of four values that ship as placeholders, and leaving one set produces
exactly this error with no hint about where it came from.
`npm run upgrade -- --dry-run` lists any you missed.

### Supported providers / why no Instagram

Configured providers are GitHub, Google, Facebook, X (Twitter), and
Discord. A provider's sign-in button appears only when **both** its
`*_CLIENT_ID` and `*_CLIENT_SECRET` are set.

- **X (Twitter)** uses OAuth 2.0 with PKCE and returns **no email** — X
  users sign in with name + avatar only. Because `ADMIN_EMAILS`
  auto-promotion matches on a verified email, X accounts can't be
  auto-promoted to admin; promote them from the admin Users page
  instead.
- **Instagram is intentionally not supported.** Meta shut down the
  Instagram Basic Display API (Dec 2024); the replacement login flows
  are aimed at business/creator accounts, return no email, and aren't
  suited to a "sign in to comment" use case.

### Google sign-in works for me but not for other users

Google blocks "unverified app" sign-in for anyone outside the consent
screen's test-user list until you submit the app for verification.
For a public deployment, complete Google's OAuth verification
(7-10 business days). For an internal blog, add each user to the
test-user list.

## Cookies and sessions

### Sessions don't persist across reload (cross-origin embed)

`SameSite=None; Secure; Partitioned` is the right config, but it
requires HTTPS even in dev. For cross-origin local testing, run
`wrangler dev --local --https`.

For same-origin local testing (visiting `localhost:8787` directly),
set `ENV=dev` in `.dev.vars` — that flips cookies to `SameSite=Lax`
so plain HTTP works.

### Sign-out doesn't actually sign me out

`POST /api/v1/auth/signout` revokes the session server-side — it deletes
the `sess:<id>` row from KV and then expires the cookie — so a retained
copy of the cookie is inert immediately. If you instead clear the cookie
out-of-band (e.g. via DevTools) without hitting `/signout`, the KV row
lingers until its TTL expires (≤30 days); call `/signout` to revoke it
now.

## Reply notification emails

### A reader subscribed but nothing arrives after 15 minutes

Check, in order:

1. `EMAIL_PROVIDER=resend` is set in `wrangler.toml`.
2. `RESEND_API_KEY` is set as a secret (`wrangler secret list`).
3. `EMAIL_FROM` is set, and the from-address domain is verified in
   the Resend dashboard.
4. `PUBLIC_BASE_URL` is set — the email needs it for permalinks and for
   the confirm/unsubscribe links.
5. The cron trigger is configured: `[triggers] crons = ["*/15 * * * *"]`
   in `wrangler.toml`. View runs in the dashboard under your worker.

### Notification emails arrive but links go to the wrong URL

`PUBLIC_BASE_URL` should point at the **worker**, not the blog. The
`/c/:id` redirect lives on the worker and bounces to the post's URL
with a `#garrul-comment-<id>` anchor.

### A reader says they can't unsubscribe

There are four exits; walk them in this order.

1. **The mail client's own Unsubscribe button** (Gmail, Apple Mail).
   Digests carry RFC 8058 `List-Unsubscribe` and
   `List-Unsubscribe-Post` headers, and the client only renders that
   button when it trusts the sender — so a missing button usually means
   DKIM/SPF alignment, not a Garrul bug. Open the message, ⋮ → **Show
   original**, and check that both headers are present and that DKIM and
   SPF say `PASS`.
2. **The link at the bottom of the digest.** It renders a confirmation
   page rather than unsubscribing on load, so a reader who clicked it and
   saw a page is not yet unsubscribed — they have to press the button.
   If that page 404s, `PUBLIC_BASE_URL` is wrong (see above) or the
   subscription was already cancelled; a spent token is not reusable.
3. **That same page's list of their other threads**, with an
   unsubscribe-from-all. This is the answer for "I follow twenty posts
   and I'm not hunting twenty emails."
4. **The widget**, but only for a reader signed in with a
   provider-verified address (GitHub, Google). The 🔔 toggles off and a
   **Manage subscriptions** disclosure lists every thread. A reader
   signed in via X/Twitter has no address on their account, so they get
   the plain subscribe bell and must use one of the email routes.

You can always cancel it for them from *Admin → Subscriptions*.

### The bell doesn't turn off for a signed-in reader

It only becomes a toggle when the session carries an address. Check
*Admin → Users* for that account: an X/Twitter sign-in, or an OAuth
account whose provider withheld the email, has none. Nothing is broken —
the bell stays a one-way subscribe action, and the reader unsubscribes
by email instead.

A bell that looks lit but dashed/dimmed is the third state: subscribed
but **awaiting confirmation**. Nothing is delivered to that address
until they click the link in the confirmation email.

## Performance

### First comment load feels slow

The first request after a deploy is a cold start (~50ms more than
steady state). After that, the edge tree cache serves anonymous
viewers in ~5ms. Signed-in viewers always bypass cache (their "did
I react?" set is per-user).

That cache is the Cloudflare Cache API (`caches.default`), not KV —
`src/lib/response-cache.ts` owns the Cache API wrapper and explains why
not KV; `src/lib/tree-cache.ts` builds the first-page keys and handles
invalidation.

The cache TTL is 60s and it can't be busted globally, so a moderation
action can take up to a minute to disappear for anonymous viewers.

### `embed.js` is slow to load

Cloudflare caches `embed.js` at the edge for a day. If you're seeing
multi-second loads, your DNS isn't pointing at Cloudflare. Verify
with `dig comments.<yourdomain>` — the answer should be a Cloudflare
anycast IP, not a Workers domain like `*.workers.dev`.
