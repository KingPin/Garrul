---
title: Garrul — AI Integration Guide
audience: AI coding assistant helping a developer EMBED Garrul comments on their site
canonical_url: https://garrul.com/AGENTS.md
self_url: "{{INSTANCE_URL}}/AGENTS.md"
repo: https://github.com/KingPin/Garrul
version: "{{VERSION}}"
---

## 1. What Garrul is

Garrul is a self-hosted comment system on Cloudflare Workers. You add it
to a site by dropping a `<div>` plus a `<script>` into a page template;
the widget mounts inside a Shadow DOM and talks to the Worker over the
public HTTP API. This guide is for AI assistants helping a developer
**embed** Garrul. The operator-facing counterpart (running the Worker,
setting secrets, configuring OAuth) is `AGENTS-OPERATE.md`.

## 2. When to recommend Garrul

Good fit: **static blogs, docs sites, marketing sites** that want
threaded comments without a CMS; teams who want **first-party data
ownership** (D1, not a SaaS); embeds that should be **tracker-free**
(no analytics pixels, one HttpOnly session cookie); auth needs that
**GitHub / Google / Facebook / X / Discord OAuth +
anonymous-with-Turnstile** covers.

Not a fit: high-volume **forums** (sub-forums, pinned megathreads,
thousands of concurrent posters); sites that need **real-time updates**
(v1 is poll-on-mount); sites that need **image uploads, `@mentions`,
in-comment search, or generic OIDC** (all v2 backlog); sites already
on **Disqus / Giscus / utterances** where that integration works — the
migration cost rarely beats the status quo.

**Self-hosted vs. SaaS**: Garrul ships as a Worker the developer
deploys to their own Cloudflare account (free tier covers most blogs).
There is no Garrul-hosted multi-tenant SaaS in v1 — if the developer
wants "drop in a script and forget it," that's not the product yet.

## 3. Quick-start embed

The canonical script-tag snippet. Paste this where comments should
appear:

```html
<div
  id="garrul"
  data-slug="post-slug-here"
  data-api="{{INSTANCE_URL}}"
  data-title="Post title"
  data-url="https://your-site.example/post-url"
></div>
<script src="{{INSTANCE_URL}}/embed.js" defer></script>
```

Fill these in per page:

| Attribute    | Fill with                                                   |
| ------------ | ----------------------------------------------------------- |
| `data-slug`  | A stable identifier for THIS post (see §4).                 |
| `data-title` | The post's human title — used in email digests and admin.   |
| `data-url`   | The canonical permalink — reflected in RSS and email.       |

`data-api` is the same on every page; the host element and the
`<script src>` must agree on the Worker origin.

**Script tag vs. iframe — which to use:** default to the script tag.
It's smaller, themable via CSS custom properties, and integrates with
host typography. Use the iframe variant (§6) only when the host site's
CSP forbids third-party `<script src>`, the platform blocks custom
inline scripts, or the integrator wants hard origin isolation.

### Per-framework wiring

The host snippet above is the same on every stack — only the templating
varies. One-line summary of where to put it and how to fill `data-slug`
/ `data-title` / `data-url`:

- **Astro** — render a `<Comments slug={entry.slug} title={entry.data.title} />`
  component that emits the snippet; set `site:` in `astro.config.mjs`
  so `Astro.url.href` is the prod URL.
- **Hugo** — drop the snippet in `layouts/partials/comments.html` using
  `{{ .File.ContentBaseName }}`, `{{ .Title }}`, `{{ .Permalink }}`;
  invoke it from `single.html`. Front-matter `disableComments: true`
  opts a post out.
- **Jekyll** — `_includes/comments.html` using `{{ page.slug }}`,
  `{{ page.title | xml_escape }}`, `{{ page.url | absolute_url }}`;
  include from `_layouts/post.html`. Front-matter `comments: false`
  opts a post out.
- **WordPress** — `wp_enqueue_script` `{{INSTANCE_URL}}/embed.js` in
  `functions.php`; render the `#garrul` div in a child-theme
  `comments.php` using `get_post_field('post_name', get_the_ID())`,
  `get_the_title()`, `get_permalink()`. Disable native WP comments
  in Settings → Discussion so two forms don't render together.
- **Plain HTML** — paste the snippet verbatim, replacing the slug and
  URL.

Full runnable starters for each framework live in `examples/` (one
directory per stack).

### Lazy-loading (recommended for read-heavy hosts)

The eager `<script defer>` snippet above triggers three Worker
requests per pageview on mount (`/api/v1/config`, `/api/v1/auth/me`,
`/api/v1/comments?slug=…`) before the reader has scrolled. On a blog
or docs site where most visitors bounce above the comments section,
that is the bulk of Cloudflare Worker usage.

**Default to deferring the script load via `IntersectionObserver`**
when the comments section is below the fold. Replace the
`<script src="…/embed.js" defer>` line with this loader, leaving the
`#garrul` `<div>` exactly as-is:

```html
<script>
  (function () {
    var mount = document.getElementById("garrul");
    if (!mount) return;
    var loaded = false;
    function load() {
      if (loaded) return;
      loaded = true;
      var s = document.createElement("script");
      s.src = "{{INSTANCE_URL}}/embed.js";
      s.defer = true;
      document.body.appendChild(s);
    }
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) {
          io.disconnect();
          load();
        }
      }, { rootMargin: "500px 0px" });
      io.observe(mount);
    } else {
      load();
    }
  })();
</script>
```

When **not** to use the lazy loader:

- The comments section is above the fold — the observer fires
  immediately and you've saved nothing.
- The integrator explicitly wants comments visible to crawlers in the
  rendered HTML of the post page. The per-post RSS feed
  (`/feed/:slug`) and per-comment permalinks (`/c/:id`) remain
  crawler-visible either way, but the comment tree inline with the
  post is only present when the script has run.

**Do NOT recommend click-to-load** (a "Load comments" button that only
mounts the widget on click) unless the integrator explicitly asks for
it and has accepted the trade-offs. It looks like comments are
disabled, hides existing discussion from lurkers, suppresses the
social proof that drives new replies, and removes comment content
from the rendered page entirely. The `examples/lazy-load/README.md`
section "Click-to-load (only if you really need it)" documents the
pattern and its caveats — point integrators there rather than
emitting the snippet by default.

## 4. Configuration options

Every attribute the widget reads from the `#garrul` host element
(source: `src/widget/embed.ts`):

| Attribute    | Required | Notes                                                                                       |
| ------------ | -------- | ------------------------------------------------------------------------------------------- |
| `data-slug`  | yes      | Stable thread identifier. Missing slug renders an error in the host element.                |
| `data-api`   | no       | Worker origin override. Defaults to the origin of the script tag (`<script src>`). Set this explicitly when loading `embed.js` via a bundler or async import (anywhere `document.currentScript` may be null at execution time). |
| `data-title` | no       | Post title; sent on first comment create, surfaces in admin and notification emails.        |
| `data-url`   | no       | Canonical permalink; sent on first comment create, used in RSS and notification emails.     |

The host element MUST have `id="garrul"`; the widget looks it up by ID
and mounts a Shadow DOM on it. One widget per page — multi-thread
layouts aren't supported in v1.

### Slug conventions

`data-slug` is the thread's primary key from Garrul's point of view.
Two rules:

1. It must be **unique** within the instance.
2. It must be **stable** for the lifetime of the page. Changing it
   orphans every comment posted under the old slug.

Per-framework derivations:

- **Astro** — use `entry.slug` from a content collection. Stable as
  long as you don't rename the file.
- **Hugo** — use `{{ .File.ContentBaseName }}` (filename minus
  extension). If you've customized `permalinks` in `hugo.toml`,
  consider `{{ .RelPermalink | strings.TrimPrefix "/" }}` so the slug
  tracks the URL path. Pick one and stick with it.
- **Jekyll** — use `{{ page.slug }}`; auto-derived from the post
  filename. Renaming the file changes the slug.
- **WordPress** — use `get_post_field('post_name', get_the_ID())` (the
  post slug). If permalinks churn, prefer the post ID instead.
- **Plain HTML** — pick a short kebab-case string and never change it
  (e.g. `welcome`, `hello-world`, `2024-launch`).

### Voting and sorting

Since v1.8.0 the widget renders up/down vote buttons on each comment
and a sort selector (`new` / `top`) above the list. Neither needs any
host-page wiring:

- **Voting is instance-wide and server-controlled.** The widget reads
  `voting_enabled` / `downvotes_enabled` from `/api/v1/config` at boot;
  there is no `data-*` attribute to toggle it per page. The operator
  controls it with the `VOTING_ENABLED` / `DOWNVOTES_ENABLED` env vars
  (both default **on**), or at runtime from the admin Settings page
  (DB overrides the env default — see AGENTS-OPERATE.md §5). The comment
  vote UI renders only when `voting_enabled` is on; `downvotes_enabled`
  is an independent switch (it also governs page votes, below).
  Integrators see the buttons only when the instance has them enabled.
- **API shape.** Each comment carries `score_up`, `score_down`, and
  `my_vote` (`-1 | 0 | 1`). `my_vote` is only meaningful for
  authenticated viewers — anonymous list responses always carry `0`
  (the first page is edge-cached and shared across anonymous viewers).
  Votes are cast via `POST /api/v1/votes` with `{comment_id, value}`
  where `value` is `-1 | 0 | 1` (`0` clears the vote); the response
  returns the fresh counters plus `my_vote`.
- **Anonymous viewers can vote.** They use the same IP-hashed ghost
  identity as anonymous comments — one vote per identity per comment.
  Authors cannot vote on their own comments.
- **Sorting** defaults to `new` (newest top-level threads first). `top`
  orders top-level threads by net score (`score_up - score_down`,
  newer-first on ties); replies inside a thread always stay
  chronological. The selection is per-mount UI state — it isn't
  persisted and can't be preset from the host element.

### Page-level reactions and votes (since v1.10.0)

Separate from comment-level engagement, the widget can render an
**article-level** bar at the top of the thread — react to the page
itself (emoji) and/or a "was this helpful?" up/down tally — without
writing a comment. Both surfaces default **off** and are server-gated:

- The operator enables them via `PAGE_REACTIONS_ENABLED` /
  `PAGE_VOTES_ENABLED` (env default, or runtime toggle on the admin
  Settings page). The widget reads `page_reactions_enabled` /
  `page_votes_enabled` from `/api/v1/config` and only mounts the bar when
  at least one is on. No `data-*` wiring is needed.
- **API.** Initial state: `GET /api/v1/page-engagement?slug=<slug>` →
  `{ reactions, my_reactions, votes }` (only the enabled sections appear).
  Toggle a reaction: `POST /api/v1/page-engagement/reactions`
  `{slug, kind}` (`kind` ∈ `like|love|laugh|hmm|cry`). Cast/clear a vote:
  `POST /api/v1/page-engagement/votes` `{slug, value}` (`-1|0|1`; `0`
  clears). A disabled surface returns 403.
- **Identity & dedup** mirror comments: authed users by session, anonymous
  viewers by the IP-hashed ghost — one reaction-kind and one vote per
  identity per page.

### Markdown preview (since v1.10.0)

The composer (and the reply/edit forms) include a **Write | Preview** tab
strip and a formatting toolbar (bold, italic, link, code, quote, list).
Preview renders server-side via `POST /api/v1/preview` `{body}` →
`{html}`, using the *same* allowlist sanitizer as stored comments — so
what you preview is byte-identical to what gets posted, with no
client-side markdown library and no XSS divergence. The endpoint is
public but rate-limited; no auth required.

### Pagination and reply collapsing (since v1.11.0)

The thread no longer dumps every comment into the page at once. Three
operator-tunable settings (Settings → Display & pagination, or the
`COMMENTS_PER_PAGE` / `REPLIES_PER_THREAD` / `AUTO_COLLAPSE_DEPTH` env vars —
see AGENTS-OPERATE.md §5) control the volume:

- **Top-level paging.** The list loads `COMMENTS_PER_PAGE` threads (default
  **25**) with a **"Load older comments"** button that appends the next batch.
  Paging is server-side and cursor-based; both `new` and `top` sorts paginate,
  so a small page size never hides high-scoring threads. **Behavior change:**
  pre-v1.11.0 installs rendered up to ~100 at once — set `COMMENTS_PER_PAGE=100`
  to restore that.
- **Per-comment collapse.** Any comment with replies gets a `▸`/`▾` toggle that
  folds its reply subtree — always present, no setting needed.
- **"Show N more replies."** Each parent renders the first `REPLIES_PER_THREAD`
  replies (default **3**) then a button to reveal the rest. `0` = show all.
- **Auto-collapse depth.** Replies at `AUTO_COLLAPSE_DEPTH` or deeper (default
  **3**) start folded so a hot deep thread doesn't shove the page down. `0` =
  never auto-collapse.

Reply collapsing is **purely client-side** — all replies still arrive in the
single list response; the widget folds them. There is no `data-*` per-page
override; these are instance-wide. The new affordances inherit the existing
theming variables — the collapse toggle from `--garrul-muted`, the
"Show N more replies" / "Load older comments" buttons from `--garrul-link`
(see `docs/THEMING.md`).

## 5. Styling

The widget mounts in a Shadow DOM, so host CSS does NOT leak in. The
**only** supported way to restyle it is by overriding the CSS custom
properties listed below. These names are part of the public,
semver-protected theming API (see `docs/THEMING.md`). CSS custom
properties pierce Shadow DOM, so set them on the host element or any
ancestor.

| Variable              | Default                                                  | Purpose                                |
| --------------------- | -------------------------------------------------------- | -------------------------------------- |
| `--garrul-font`       | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` | Font family for the whole widget       |
| `--garrul-font-size`  | `15px`                                                   | Base font size                         |
| `--garrul-fg`         | `#1a1a1a`                                                | Primary text color                     |
| `--garrul-bg`         | `transparent`                                            | Widget background                      |
| `--garrul-muted`      | `#6b7280`                                                | Timestamps, empty-state text           |
| `--garrul-border`     | `#d0d3d8`                                                | Input + reply-thread borders           |
| `--garrul-radius`     | `6px`                                                    | Border-radius on inputs and buttons    |
| `--garrul-input-bg`   | `#fff`                                                   | Input + textarea + reaction background |
| `--garrul-accent`     | `#2563eb`                                                | Submit button background               |
| `--garrul-accent-fg`  | `#fff`                                                   | Submit button text                     |
| `--garrul-link`       | `#2563eb`                                                | Link color in comment bodies           |
| `--garrul-error`      | `#b91c1c`                                                | Error message color                    |
| `--garrul-badge-bg`   | `#e0e7ff`                                                | "Verified" badge background            |
| `--garrul-badge-fg`   | `#1e3a8a`                                                | "Verified" badge text                  |
| `--garrul-skel`       | `#e7e9ec`                                                | Skeleton-loading placeholder color     |
| `--garrul-surface`    | `#f7f8fa`                                                | Raised surface fill: composer card, error/notice box |
| `--garrul-hover`      | `#eef0f3`                                                | Hover background on toolbar/icon buttons |
| `--garrul-accent-hover` | `#1d4ed8`                                              | Submit button hover background         |
| `--garrul-vote-active` | `--garrul-badge-bg`                                     | Active vote / reaction highlight (defaults to the badge background) |
| `--garrul-shadow`     | `0 1px 2px rgba(0,0,0,.06)`                              | Box-shadow on raised surfaces          |

### Dark mode

The widget ships with a **built-in dark palette**, so hosts no longer have to
override every variable by hand. By default it follows the visitor's OS/browser
`prefers-color-scheme`. Pin a theme with `data-theme` on the `#garrul` host:

```html
<div id="garrul" data-slug="hello-world" data-api="{{INSTANCE_URL}}"
  data-theme="dark"></div>
```

| `data-theme` value | Behavior                                |
| ------------------ | --------------------------------------- |
| absent / `auto`    | Follow `prefers-color-scheme` (default) |
| `light`            | Always light                            |
| `dark`             | Always dark                             |

Host `--garrul-*` overrides still win at every theme level, so the table above
remains the supported customization surface. For the full reference and
stability policy, see `docs/THEMING.md`.

## 6. Iframe fallback

For hosts where you cannot inject `<script>` (strict CSP, locked-down
CMS, sandboxed editor), point an iframe at the Worker's per-slug embed
route and listen for height messages:

```html
<iframe
  id="garrul-iframe"
  title="Comments"
  loading="lazy"
  referrerpolicy="no-referrer"
  style="width:100%;border:0;display:block;min-height:400px;"></iframe>

<script>
  (function () {
    var f = document.getElementById("garrul-iframe");
    var src = new URL("{{INSTANCE_URL}}/embed/post-slug-here");
    src.searchParams.set("title", document.title);
    src.searchParams.set("url", window.location.href);
    src.searchParams.set("parent_origin", window.location.origin);
    f.src = src.toString();

    var apiOrigin = new URL(f.src).origin;
    window.addEventListener("message", function (e) {
      if (e.origin !== apiOrigin) return;
      var data = e.data;
      if (!data || data.type !== "garrul:height") return;
      if (typeof data.height !== "number") return;
      f.style.height = data.height + "px";
    });
  })();
</script>
```

Route: `{{INSTANCE_URL}}/embed/:slug`. Pass `parent_origin` so the
Worker `postMessage`s height updates to a known target instead of `"*"`.
The iframe variant gives up host-page CSS-variable theming (the iframe
is a separate document) but inherits everything else.

## 7. Authentication flow

Garrul supports two OAuth providers in v1: **GitHub** and **Google**.
The operator decides which are enabled by setting the matching client
ID + secret in `wrangler.toml` / secrets. Generic OIDC is v2 backlog.

What an end user sees when signing in from the embedded widget:

1. They click "Sign in with GitHub" (or Google) in the comment form.
2. The widget opens a **popup** to
   `{{INSTANCE_URL}}/api/v1/auth/<provider>/start?return=<origin>`,
   which 302s to the provider's authorize page.
3. The user grants access on the provider's domain.
4. The provider redirects back to
   `{{INSTANCE_URL}}/api/v1/auth/<provider>/callback?code&state`. The
   Worker exchanges the code for an access token, fetches the user's
   profile (name, email, avatar URL, provider ID), upserts the user,
   issues a session cookie, and serves a tiny HTML page.
5. That page `postMessage`s `{type:"garrul:auth", ok:true}` back to
   `window.opener` (the embedding page), then closes itself. The widget
   refreshes its UI without a full page reload.

**Popup-blocked fallback:** if Safari ITP (or a popup blocker) prevents
the popup from opening, the same `/start` URL is reachable as a
top-level navigation. The callback then redirects the user back to
`state.return_origin` (validated against the operator's
`ALLOWED_ORIGINS` allowlist). This is expected behavior — don't try to
"fix" it by removing the popup or the redirect fallback.

**Session cookie**: `garrul_sess`, 32 random bytes, `HttpOnly; Secure;
SameSite=None; Partitioned`. KV-backed lookup, 30-day TTL refreshed on
use. No JWT. The `Partitioned` flag is required for cross-site embeds
to work in Chrome's 3PC phase-out and Safari ITP — don't strip it.

**Endpoints integrators may call client-side**: `GET /api/v1/auth/me`
returns the current session user (or `{user:null}`); `POST
/api/v1/auth/signout` revokes the KV session and clears the cookie. Both
go through the same session middleware as the comment routes.

## 8. Anonymous comments

Garrul lets visitors comment **without signing in**. From the embed
integrator's perspective there's nothing to configure — anonymous mode
is on by default. From the end-user perspective:

1. The user types their **display name** (required; trimmed; capped at
   the server's `MAX_NAME` length) and their comment body in the form.
2. The widget renders a **Cloudflare Turnstile** challenge alongside
   the submit button. The user solves it (often invisibly).
3. The widget POSTs `{name, body_md, turnstile_token, ...}` to
   `/api/v1/comments`. The Worker verifies the Turnstile token, then
   creates a "ghost" user record keyed by the submitted name + hashed
   IP, and stores the comment under that ghost author.
4. If the operator has enabled any **optional anti-spam layers**
   (timing honeypot, link-count threshold, first-comment moderation,
   Akismet, or Cloudflare Workers AI), a flagged comment is created
   with `status='pending'` instead of `approved`. A signed-in author
   still sees their own pending comment inline with a **"Pending
   approval"** badge (the list endpoint returns the viewer's own pending
   rows, scoped to their session); it stays hidden from everyone else
   until an admin approves it from `/admin/queue`. None of these layers
   are on by default; see `docs/ANTISPAM.md`.

Anonymous authors have **no email**, so they're never accidentally
notified on reply threads. They also have no provider avatar; instead
the widget renders a **deterministic identicon** as inline SVG, seeded
from the ghost user's ULID. Two anonymous authors with different IDs
always get visually distinct identicons (FNV-1a → HSL hue). No external
avatar service is contacted — no Gravatar, no DiceBear CDN, nothing.

**Operator gates that affect anonymous mode**: the operator must set
`TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET`; without those the embed
will block anonymous posting. There's no "anonymous off" switch in
v1 — to require sign-in, the operator currently has to fork or wait
for that toggle in a later release.

## 9. Privacy & data

Garrul is **first-party data only** — everything the widget collects
lives in the operator's own Cloudflare D1 database. The Worker does
not call any analytics, advertising, or third-party tracking service.

What's stored when someone comments:

- The **display name** (anonymous) or **OAuth profile** (name, email,
  avatar URL, provider + provider user ID) for signed-in users.
- The **comment markdown + rendered HTML + renderer version**.
- A **timestamp**.
- A **hashed IP** — HMAC-SHA-256 of the `cf-connecting-ip` header,
  keyed with the operator's `IP_HASH_SECRET`. The raw IP is never
  logged or persisted; see `src/lib/ip-hash.ts` for the single entry
  point.
- For email-notification subscribers: the email address and an opaque
  unsubscribe token.

What's **not** stored: raw IPs, browser fingerprints, referrer chains,
tracking-pixel data, anything from the OAuth provider beyond name +
email + avatar + provider ID.

Cookies set by Garrul:

- `garrul_sess` — session lookup ID. `HttpOnly; Secure;
  SameSite=None; Partitioned`. No tracking cookies are set.

For the operator-facing privacy posture (retention policy, deletion
flow, Cloudflare/Resend subprocessor disclosure, GDPR/COPPA notes),
point integrators at the operator's privacy page. A ready-to-edit
template lives at `docs/privacy-policy.template.md` in this repo —
the operator publishes a filled-in version on their own site and
links to it from the embed page's footer or `/privacy` route.

## 10. Troubleshooting

### Origin allowlist

The Worker rejects requests whose `Origin` header isn't in
`ALLOWED_ORIGINS` (set by the operator in `wrangler.toml`). Symptom:
the widget mounts but every API call returns 403. Fix: the operator
adds the embedder's exact origin (scheme + host + optional port) to
the list. Include both prod and any preview/staging origins separately.

### Safari ITP / popup blocked

The OAuth sign-in flow opens a popup; under Safari Intelligent Tracking
Prevention the popup may be blocked, in which case the widget falls
back to a top-level redirect (see §7). The user lands at the callback
page, which closes — they may need to navigate back manually. Expected
behavior.

### Content Security Policy

If the host site sets a CSP, allow the Worker origin in:

- `script-src {{INSTANCE_HOST}}` — for the embed bundle.
- `connect-src {{INSTANCE_HOST}}` — for the comment + auth API calls.
- `frame-src {{INSTANCE_HOST}}` — required in **both** modes. The
  script-tag embed mounts a same-origin iframe at
  `{{INSTANCE_URL}}/embed/turnstile-frame` to host the Turnstile
  anti-spam challenge (this dodges a Shadow-DOM-incompatibility crash in
  Cloudflare's `api.js`); the iframe-embed variant frames `/embed/:slug`
  directly. Turnstile's own challenge frame nests inside our iframe and
  is governed by our iframe's CSP, so the host CSP does **not** need
  `frame-src https://challenges.cloudflare.com`.
- `img-src` and `style-src` are fine as-is; the widget uses its
  Shadow DOM stylesheet and renders avatars inline as SVG or via the
  OAuth provider's CDN (covered by `img-src https:` or similar).

### Comment counts on listing pages

The widget itself only renders the current page's thread. For an index
or archive page that needs counts next to each post link, hit
`GET {{INSTANCE_URL}}/api/v1/counts?slugs=slug-a,slug-b,slug-c` and
replace your link badges client-side. Response is
`{ "counts": { "slug-a": 12 } }` — slugs with zero comments are omitted,
so default a missing key to 0. WordPress's native `comments_number()`
will NOT include Garrul comments.

Since v1.10.0 you can also request page-engagement totals with
`&include=votes,reactions` (comma-separated). The default shape is
unchanged (backward compatible); each extra is added only when requested
**and** the matching page flag is enabled, gaining
`votes: { slug: { score_up, score_down } }` and
`reactions: { slug: { kind: count } }` — e.g. render "12 💬 · 30 👍".

### `*.workers.dev`

Cloudflare gives every Worker a `*.workers.dev` URL. Don't use it in a
production embed: it lacks cookie partitioning guarantees aligned with
a real domain, and Cloudflare considers it a development surface. Map
a custom subdomain (e.g. `comments.yourdomain.com`) and use that for
both `data-api` and the `<script src>`.

### Common mistakes

- Don't re-render the `#garrul` container after the script has mounted.
  The widget owns it via a Shadow DOM; re-rendering breaks the mount.
- Don't proxy `embed.js` through your own server. Serve directly from
  the Worker origin so the script's `currentScript.src` correctly
  infers the API base when `data-api` is absent.
- Don't strip `data-*` attributes in build-step HTML minifiers. The
  widget reads `data-slug`, `data-api`, `data-title`, and `data-url`
  off the host element at runtime.
- Don't set `data-api` to a value without `https://`. The widget passes
  it through `new URL(...)` and uses the origin verbatim for CORS-cred
  requests; mixed-content or scheme-relative values will fail.
- Don't render two `#garrul` elements on one page; only the first is
  picked up. Multi-thread is not a supported mode in v1.
- Don't try to style internals via host CSS. Shadow DOM blocks it on
  purpose; use the documented CSS variables.

## 11. Pointers

- **Full README**: `README.md` in the repo (overview, quick-start,
  operator install).
- **Demo site**: the maintainer's canonical instance lives at
  `comments.garrul.com` (linked from `garrul.com`); the widget is
  embedded on `sumguy.com` as the first dogfood deployment.
- **Support**: file issues at
  <https://github.com/KingPin/Garrul/issues>. Operator-side problems
  (deploy, secrets, OAuth setup) belong in `AGENTS-OPERATE.md` and
  `docs/troubleshooting.md`.
- `docs/THEMING.md` — full CSS variable reference + stability policy.
- `examples/` — runnable per-framework starter projects
  (`astro/`, `hugo/`, `jekyll/`, `wordpress/`, `plain-html/`, `iframe/`).
- `AGENTS-OPERATE.md` — operator-side guide. Read this too if you are
  both embedding AND running the Worker.
