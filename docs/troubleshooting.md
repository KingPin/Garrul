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

### Posting a comment fails with "Spam check failed. Refresh and try again."

The Turnstile (anti-spam) widget never loaded, so the form submitted
without a token and the API rejected it. The browser console usually
shows a CSP violation referencing the Worker origin, e.g.:

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

### "redirect_uri_mismatch" on GitHub or Google

The redirect URI registered in your OAuth app must exactly match
`OAUTH_CALLBACK_BASE` + `/api/v1/auth/<provider>/callback`. No trailing
slash, no `www.` if your worker doesn't serve `www.`.

GitHub OAuth apps allow exactly one callback URL. For staging +
production, register two OAuth apps and switch credentials per
deployment.

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

`POST /api/v1/auth/signout` clears the cookie. If the session row in
KV still exists (you cleared the cookie out-of-band, by editing
DevTools), the KV row will TTL out in 30 days.

## Email digests

### Nothing happens after 15 minutes

Check, in order:

1. `EMAIL_PROVIDER=resend` is set in `wrangler.toml`.
2. `RESEND_API_KEY` is set as a secret (`wrangler secret list`).
3. `EMAIL_FROM` is set, and the from-address domain is verified in
   the Resend dashboard.
4. `PUBLIC_BASE_URL` is set — the digest needs it for permalinks.
5. The cron trigger is configured: `[triggers] crons = ["*/15 * * * *"]`
   in `wrangler.toml`. View runs in the dashboard under your worker.

### Digest emails arrive but links go to wrong URL

`PUBLIC_BASE_URL` should point at the **worker**, not the blog. The
`/c/:id` redirect lives on the worker and bounces to the post's URL
with a `#garrul-comment-<id>` anchor.

## Performance

### First comment load feels slow

The first request after a deploy is a cold start (~50ms more than
steady state). After that, the tree-cache KV serves anonymous
viewers in ~5ms. Signed-in viewers always bypass cache (their "did
I react?" set is per-user).

### `embed.js` is slow to load

Cloudflare caches `embed.js` at the edge for a day. If you're seeing
multi-second loads, your DNS isn't pointing at Cloudflare. Verify
with `dig comments.<yourdomain>` — the answer should be a Cloudflare
anycast IP, not a Workers domain like `*.workers.dev`.
