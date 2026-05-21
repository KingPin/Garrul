# Garrul integration examples

Drop-in snippets for the most common ways to embed the Garrul widget on a
host site. Pick the folder that matches your stack — each one is a
self-contained recipe.

All examples assume your Worker is reachable at
`https://comments.yourdomain.com`. Replace that origin with whatever you
configured in `wrangler.toml` (`[[routes]]` for a custom domain, or the
`*.workers.dev` URL while testing).

## Pick an example

| Folder                             | What it shows                                                  | Start here if…                                                            |
| ---------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`plain-html/`](./plain-html/)     | Single static page mounting against `localhost:8787`           | You're running `npm run dev` and want to poke the widget locally          |
| [`astro/`](./astro/)               | Per-page snippet + shared `<Comments>` component               | Your blog is built with Astro                                             |
| [`hugo/`](./hugo/)                 | `comments.html` partial wired into `single.html`               | Your blog is built with Hugo                                              |
| [`jekyll/`](./jekyll/)             | `_includes/comments.html` + `_config.yml` settings             | Your blog is built with Jekyll (incl. GitHub Pages)                       |
| [`wordpress/`](./wordpress/)       | Child-theme enqueue + `comments.php` replacement               | You're on WordPress (classic or block themes)                             |
| [`iframe/`](./iframe/)             | `<iframe>` embed with `postMessage` height sync                | Your host has a strict CSP and can't allow inline `<script>`              |
| [`lazy-load/`](./lazy-load/)       | Scroll-into-view and click-to-load deferred loaders            | You want to cut Worker requests from bouncers on a high-traffic blog     |

The framework recipes are deliberately near-identical at the HTML level —
the only thing that varies is how each platform renders the four `data-*`
attributes from its post metadata.

## The embed contract

Every recipe boils down to a mount element plus the `embed.js` script:

```html
<div
  id="garrul"
  data-slug="my-post-slug"
  data-api="https://comments.yourdomain.com"
  data-title="My post title"
  data-url="https://example.com/my-post/"
></div>
<script src="https://comments.yourdomain.com/embed.js" defer></script>
```

| Attribute    | What it does                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `data-slug`  | Stable identifier for the comment thread. Changing it orphans existing comments — pick something tied to the post's identity, not its URL. |
| `data-api`   | Origin of your Worker. Must match an entry in `ALLOWED_ORIGINS`.                                                                     |
| `data-title` | Human-readable title shown in email digests and the per-post RSS feed.                                                                |
| `data-url`   | Canonical permalink for the post. Reflected back in email digests and used to build per-comment permalinks (`/c/:id`).               |

The widget mounts inside a Shadow DOM, so host CSS does not leak in. The
`plain-html/` example includes a "host-bleed-check" block you can use to
verify this locally.

## Worker-side checklist

Before any of these recipes work end-to-end, the Worker has to know about
your site:

1. **`ALLOWED_ORIGINS`** in `wrangler.toml` — list every origin that will
   embed the widget. CORS and the CSRF origin check both read this list.
   Include local dev origins (e.g. `http://localhost:1313` for Hugo) if
   you want to test against the deployed Worker.
2. **Turnstile site key** — set `TURNSTILE_SITE_KEY` so the widget can
   render the challenge. The matching secret goes in via
   `wrangler secret put TURNSTILE_SECRET_KEY`.
3. **Cookies are cross-site** — sessions use
   `SameSite=None; Secure; Partitioned`. Both your host site and the
   Worker must be served over HTTPS in production.

See the top-level [`README.md`](../README.md) and
[`AGENTS-OPERATE.md`](../AGENTS-OPERATE.md) for the full Worker setup.

## Combining recipes

The framework examples and `lazy-load/` are orthogonal — pick a platform
recipe for *where* the widget goes, then optionally swap its inline
`<script src="…/embed.js">` for the deferred loader from `lazy-load/`
pattern 1.

The `iframe/` recipe is an alternative mounting strategy and replaces the
`<div id="garrul">` + `<script>` pair entirely.
