# Owner access

A fresh install may have no OAuth provider and no `ADMIN_EMAILS`. The owner
login gives the operator admin access anyway.

## Sign in

1. Make sure `PUBLIC_BASE_URL` in `wrangler.toml` is your real URL.
2. Run `npm run owner-link` (add `-- --local` for `wrangler dev`, or
   `-- --base-url https://host` to override the URL).
3. Open the printed link `https://<host>/admin/owner#t=<token>`.
4. Click **Sign in as owner**.

Wrangler's Cloudflare credentials authorize creating the link. The token proves
possession afterward. It lasts 10 minutes and works once. A new link revokes
older unused ones.

`npm run owner-link` prints only the link on stdout. Messages go to stderr.

## How it stays safe

- The token has 256 bits of randomness. D1 stores only its SHA-256.
- The token lives in the URL fragment, which browsers do not send to servers.
  The page removes it from the address bar immediately and posts it only when
  you click the button, so link previews cannot use it up.
- Redemption is one atomic `UPDATE ... RETURNING`; two simultaneous requests
  yield one session.
- Failures all return the same answer. The endpoint is rate limited and
  same-origin only.

## One owner, no silent recovery

There is one owner row (`provider='owner'`, `provider_id='primary'`). If an
admin bans, demotes or erases it, `npm run owner-link` refuses and says why,
and any link issued earlier stops working. To recover, restore the row in D1
yourself (`is_banned=0`, `role='admin'`, `is_admin=1`, `erased_at=NULL`), then
run the command again. For an erased owner also set `provider_id='primary'` again.
