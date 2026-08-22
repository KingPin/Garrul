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
`<script src>` must agree on the Worker origin. Omitting it falls back to
the origin the bundle was served from, which is the same answer — but
keep it in the snippet: it is the one attribute that makes the wiring
readable to whoever maintains the page next.

**Script tag vs. iframe — which to use:** default to the script tag.
It's smaller, themable via CSS custom properties, and integrates with
host typography. Use the iframe variant (§6) only when the host site's
CSP forbids third-party `<script src>`, the platform blocks custom
inline scripts, or the integrator wants hard origin isolation.

**Weight:** `embed.js` is a single self-contained bundle — no runtime
dependencies, no framework, no second request for CSS or strings. It is
currently ~15 KB gzipped, against a CI-enforced 30 KB ceiling; run
`npm run size` for the live figure rather than trusting this sentence.
The script is `defer`red and the widget only mounts on
`DOMContentLoaded`, so it never blocks rendering of the host page.

**Layout stability (since v2.9.0).** Because the widget mounts after the
page has painted, `#garrul` goes from 0px to the height of the loading
skeleton, pushing whatever sits below the thread down the page. A
non-deferred `<script>` gets this handled for you — the bundle reserves
the skeleton's height the moment it executes. With `defer` (the
recommendation above) it cannot: the script does not run until parsing
is done. Reserve the space from the host page instead:

```css
#garrul { min-height: 220px; }
```

`min-height`, not `height` — the thread grows past it, and the widget
releases its own reservation once real comments render.

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

### The mount request (since v2.15.0)

The widget opens with a single call for everything it needs to render:

```
GET /api/v1/bootstrap?slug=<slug>&sort=new|old|top&lang=<x>&hl=<y>
```

It answers, in a single invocation, everything the mount used to ask
for separately:

```jsonc
{
  "config":       { /* identical to GET /api/v1/config */ },
  "user":         { /* identical to GET /api/v1/auth/me's user */ } | null,
  "comments":     { /* identical to GET /api/v1/comments */ },
  "engagement":   { "reactions": …, "my_reactions": …, "votes": … },
  "subscription": { "subscribed": …, "pending": …, "id": … }
}
```

Every section is byte-identical to what its standalone endpoint
returns for the same inputs. The last two are **omitted entirely**
rather than nulled — `engagement` unless a page-level reaction or vote
surface is on, `subscription` unless the reader is signed in on an
install configured to send mail.

Before v2.15.0 the mount cost up to five requests, in two serial
waves: `/api/v1/config` had to be fully awaited (the tree request
needs the resolved locale) before `/api/v1/auth/me` and
`/api/v1/comments?slug=…` could go out in parallel, plus
`/api/v1/page-engagement` and `/api/v1/subscribe/mine` from their own
surfaces.

**Count the whole mount, not just this endpoint.** A post with the
comment box rendered costs **two** Worker requests: `/api/v1/bootstrap`
and `/api/v1/comments/form-token`, which the widget prefetches when the
composer renders. The Workers free tier allows 100,000 requests/day, so
that is roughly a **50k pageview/day** ceiling — up from ~25k at the
four requests a default install used to make, and ~16k with page
reactions/votes and subscriptions on.

`/embed.js` is not in that count. It ships
`Cache-Control: public, max-age=3600, s-maxage=86400`, so the
Cloudflare edge serves it and the Worker sees it about once per colo per
day rather than once per pageview.

**Nothing was removed.** `/api/v1/config`, `/api/v1/auth/me`,
`/api/v1/comments`, `/api/v1/page-engagement` and
`/api/v1/subscribe/mine` all still exist and still behave identically
— they are public API, `/api/v1/comments` is still how the widget
pages load-more, and a widget served from this repo has to keep
working against an older self-hosted Worker that has no `/bootstrap`.
When the endpoint answers a 404 — what a Worker without the route
returns — the widget silently falls back to exactly the pre-v2.15.0
call sequence. So does a 200 whose body carries no comment tree, and a
request that never lands. The 404 is remembered per API base, so a
reader on such a Worker probes once and every later reload — editing,
deleting, changing sort — goes straight to the legacy calls. Posting has
left that list in the normal case: since v2.20.0 a successful post
renders from its own `201` and reloads nothing on either path. It still
falls back to a reload when that echo cannot be rendered where it
belongs — an old or malformed payload, or a parent no longer on screen
(§4, *Posting a comment*) — so budget one request per comment and a
second only on those paths.

Any **other** non-2xx does not fall back: it surfaces as an error, the
same one a failed `/api/v1/comments` would render. The fallback is only
worth running when it will succeed. An over-quota 429, a 5xx or a WAF
403 refuses the five replacement calls exactly as it refused this one,
so falling back would turn one rejected request into six on an install
that has already hit its cap — driving usage up, and recovery down,
precisely when neither can afford it.

`/api/v1/comments/form-token` is deliberately **not** folded in, which
is why the mount is two requests and not one. Its signed timestamp
feeds the anti-spam minimum-elapsed-time heuristic, and baking one into
a shared payload would hand every reader the same start time. It is
also an invocation even when that heuristic is off — the route 404s and
the widget treats the absence as "no timing check", but a 404 still
costs a request.

### Lazy-loading (recommended for read-heavy hosts)

The eager `<script defer>` snippet above triggers two Worker requests
per pageview on mount (`/api/v1/bootstrap?slug=…` and
`/api/v1/comments/form-token`) before the reader has scrolled. On a blog
or docs site where most visitors bounce above the comments section, that
is the bulk of Cloudflare Worker usage — two requests instead of the
pre-v2.15.0 four to six, but still two per bouncer.

Turnstile is **not** in that list. The anti-spam iframe
(`/embed/turnstile-frame`, which in turn pulls Cloudflare's `api.js` and
its challenge platform) mounts only when the visitor first focuses the
comment box, so a reader who never comments never downloads it. Expect
those requests to appear on first focus rather than on page load.

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
| `data-published` | no   | Article publish time (epoch ms or ISO 8601); sent on first comment create. Anchors age-based auto-close (`AUTO_CLOSE_DAYS`). Omit and Garrul falls back to the first-comment time, which closes the thread a bit later than intended. Only relevant if the operator enabled `AUTO_CLOSE_DAYS`. |
| `data-lang`  | no       | BCP-47 tag pinning the widget's interface language (see "Language" below). Unrecognized tags fall back to English rather than erroring. |

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

### Language (since v2.7.0)

**The widget's language is a property of the site, not the reader.** A
German speaker reading an English blog gets an English widget, because a
German comment box under English prose reads as broken rather than
helpful. `Accept-Language` and `navigator.language` are therefore never
consulted — that is a design decision, not an omission.

Which language a mount renders in, most specific first:

1. `data-lang` on the `#garrul` element — explicit, per-embed, always
   wins. The only mechanism that works when the host page's
   `<html lang>` is wrong or missing.
2. The operator's `default_locale` setting (`/admin/settings`).
3. The host page's `<html lang>`, which the widget forwards as a hint.
4. English.

Only *reviewed* translations may be selected by (3). Machine-seeded
ones require the explicit opt-in at (1) — so the only person who sees an
unreviewed translation is an operator who typed the tag and therefore
reads the language.

```html
<div id="garrul" data-slug="hello-world" data-api="{{INSTANCE_URL}}"
  data-lang="de"></div>
```

Regional tags match their base language (`de-AT` → `de`), and anything
unrecognized falls back to English rather than failing the mount.

Notes for integrators:

- **English costs nothing on the wire.** The English table is compiled
  into `embed.js`; another language is fetched with the config the
  widget already requests at boot, so there is no extra round-trip and
  no English-then-translated flash.
- **`/embed.js` is locale-free and must stay that way.** Don't append
  `?lang=` to the `<script src>` — that URL is one shared edge object
  across every embed on every site.
- **Comment bodies are never translated.** Localization covers the
  widget's own chrome; user-authored markdown is stored and served as
  written.
- **Comment timestamps follow the widget locale** (since v2.9.0). Each
  one renders as a relative label — "2 hours ago", "yesterday", "last
  month" — formatted by `Intl.RelativeTimeFormat` in the resolved
  locale. Before v2.9.0 they were `YYYY-MM-DD HH:MM` in **UTC** for
  every reader regardless of where they were. The markup is a `<time>`
  element: `datetime` carries the exact ISO instant, `title` the
  reader's own local date and time. Style it with `.gr-time` as before.
  Everything else numeric — vote counts, comment counts — stays
  locale-neutral.
- The widget sets `lang` and `dir` on its own host element, so an RTL
  host page and an LTR widget (or the reverse) lay out correctly.

### Voting and sorting

Since v1.8.0 the widget renders up/down vote buttons on each comment
and a sort selector above the list. Neither needs any host-page wiring:

- **The sort selector offers `new` / `old` / `top`,** and appears
  whenever the post has comments. `top` is listed only when voting is
  on — there are no scores to rank by otherwise — but `new` and `old`
  need nothing, so since v2.16.0 the control is no longer gated on
  voting the way it was when `top` was its only alternative.
- **The order a thread opens in is the operator's**, set with
  `DEFAULT_SORT` (default `new`) or at runtime from Settings → Display &
  pagination. The widget omits `?sort=` on the mount request to mean "no
  preference"; the server resolves the default and **echoes the sort it
  used** back on the comments payload, which is what the control
  displays and what `next_cursor` is a cursor into. It cannot be derived
  client-side: on the bootstrap path the setting arrives in the same
  response as the comments it orders. A stored `top` with voting off
  resolves to `new` rather than being rewritten, so re-enabling voting
  restores the operator's choice.

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
- **Reaction kinds** are `fire|love|wow|laugh|hmm|cry` (🔥❤️😮😂🤔😢).
  **Changed in v2.10.0:** `like` 👍 was renamed to `fire` 🔥 (it duplicated
  the up-vote sitting directly below it) and `wow` was added. Migration
  0022 rewrites stored rows in both `reactions` and `page_reactions`, so
  anything reading `reactions.like` off `/api/v1/counts` or a tree
  response sees `reactions.fire` after upgrading. Both POST routes still
  accept `like` on the wire for one release and store it as `fire`, so a
  reader holding a cached pre-2.10.0 bundle keeps working. That
  compatibility runs both ways: a POST in the deprecated spelling gets
  its answer echoed in the same spelling, so the response carries both
  `fire` and a `like` key with the identical count. Without the echo the
  old bundle would look up a key that is no longer there and blank the
  cell it just incremented. Emoji are native unicode — the widget ships
  no icon artwork.
- **Comment reactions patch in place** (since v2.9.0). Toggling an emoji
  on a comment (`POST /api/v1/reactions` `{comment_id, kind}`) no longer
  re-fetches and re-renders the
  thread — the response carries `{ok, added, reactions}` where
  `reactions` is `{kind: count}` for that one comment, and the widget
  updates just that row. Scroll position, open reply composers and typed
  drafts survive a reaction now. Zero-count kinds are absent from
  `reactions`, matching the list payload — with one exception: the
  deprecated-spelling echo above always carries a value, so a POST for
  `like` that removes the last reaction answers `{"like": 0}`. Old
  bundles drop non-positive counts on merge, which is exactly how they
  clear the cell.
- **Sorting** defaults to `new` (newest top-level threads first). `top`
  orders top-level threads by net score (`score_up - score_down`,
  newer-first on ties); replies inside a thread always stay
  chronological. The selection is per-mount UI state — it isn't
  persisted and can't be preset from the host element.

### Per-comment permalinks (since v2.17.0)

Each comment's timestamp is now a link to that one comment, with no
host-page wiring required. What it resolves to depends on what the
widget knows at mount time:

1. **`data-url` is set** (recommended — see §4): the link is
   `<data-url>#garrul-comment-<id>`.
2. **No `data-url`, and the document's own origin differs from the
   Worker's API origin** — the normal case for a script-tag embed,
   where the host page and the Worker live on different origins: the
   link falls back to `location.href` with the same
   `#garrul-comment-<id>` anchor.
3. **Neither resolves** — either the document's origin *matches* the
   API origin, which happens in the iframe variant (§6) with no
   `?url=` passed, where the document being linked from **is** the
   Worker's own `/embed/:slug` page; or `location.href` is not an
   absolute http(s) URL at all (`about:srcdoc`, `blob:`, `file:`). The
   link falls back to the Worker's `GET /c/:id`, which 302s to the
   comment's stored post URL plus the same anchor.

Rung 3 exists for durability (a permalink shared from an iframe embed
still resolves after the post moves) but is deliberately the last
resort, not the default: every click of `/c/:id` is a Worker
invocation against the 100,000 requests/day free tier, where the
host-page anchor costs nothing.

It is also the rung with the most ways to miss, and the failure is
always a 404 or a link that lands nowhere rather than a wrong comment.
`/c/:id` 404s when the post has no `url` on file, when that URL fails
to parse or is not http(s), and for any comment whose status is
`pending`, `spam` or `deleted` — a moderation-queue entry has no
public permalink. A stored post URL that *already* carries a fragment
is not one of those ways: the redirect replaces that fragment rather
than joining to it with `&`, matching how rungs 1 and 2 build their
anchors. Rungs 1 and 2 have none of the remaining failure modes, which
is why they are tried first.

The link is a plain `<a href>` — no clipboard-copy JavaScript shim —
so right-click-copy, middle-click, and Cmd/Ctrl-click all work the way
a reader expects. `#garrul-comment-<id>` is the `id` the widget already
stamps on every thread node's wrapper element, and the same anchor the
per-post RSS feed (`/feed/:slug`) links to, so a permalink shared from
either surface lands on the same spot once the widget mounts.

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
  `{slug, kind}` (same vocabulary as comment reactions above). Cast/clear a vote:
  `POST /api/v1/page-engagement/votes` `{slug, value}` (`-1|0|1`; `0`
  clears). A disabled surface returns 403.
- **Identity & dedup** mirror comments: authed users by session, anonymous
  viewers by the IP-hashed ghost — one reaction-kind and one vote per
  identity per page.
- **Presentation** (since v2.10.0): the reaction bar opens with a
  "What's your reaction?" prompt and each cell carries a word under the
  emoji, so 🤔 isn't left ambiguous between "interesting" and "I doubt
  that". Per-comment reactions stay compact — same label, but as the
  button's accessible name rather than visible text.

### Subscribing to a thread (since v2.10.0)

A reader can follow a thread by email in two places, both server-gated
and needing no host-page wiring:

- the composer's "Email me about new comments" checkbox, and
- a 🔔 in the thread toolbar, for a reader who wants replies but has
  nothing to say. A signed-in reader whose provider supplied a verified
  address subscribes in one click (a provider-verified address confirms
  immediately); everyone else gets an inline email field and a
  confirmation mail.

Both read `subscriptions_enabled` from `/api/v1/config` — a derived flag,
true when the operator has set `EMAIL_FROM` and `PUBLIC_BASE_URL`. It is
not an operator toggle and has no `data-*` attribute; when false, neither
affordance renders, because `POST /api/v1/subscribe` fails closed with 503
without those vars.

Subscriptions are **thread-scoped** and unique per `(post_slug, email)`,
so a subscriber hears about every new comment on the post, not only direct
replies.

#### Unsubscribing (since v2.11.0)

There are two bells, and which one a reader gets is a security decision.

- **Anonymous, and signed in with no address** (X/Twitter exposes no email
  under our scopes): the bell is an action, not a state toggle. It never
  displays whether an address is already subscribed and offers no
  unsubscribe — that stays a tokenized link in the mail. This is
  deliberate: `POST /api/v1/subscribe` returns a constant response unless
  the caller proved they own the inbox, so an unauthenticated prober
  cannot use it to discover which addresses follow which posts, and
  rendering subscription state would require asking exactly that question.
- **Signed in with a provider-verified address**: the bell is a real
  toggle (🔔 / 🔕, plus a third "awaiting confirmation" state), and a
  **Manage subscriptions** disclosure beside it lists every thread that
  address follows with a per-row unsubscribe. There is no oracle here
  because the only address in play is one the session already proved it
  owns.

The endpoints behind the second bell are `GET /api/v1/subscribe/mine`
(the list), `GET /api/v1/subscribe/mine?post_slug=` (one thread's state:
`{subscribed, pending, id}`) and `DELETE /api/v1/subscribe/mine/:id`. All
three are session-scoped to the session's own verified address; a row that
address does not own answers **404**, never 403, so an id cannot be probed
for existence. A session with no address is not an error — it gets an
empty list and an unlit bell.

Emailed digests carry RFC 8058 `List-Unsubscribe` and
`List-Unsubscribe-Post` headers, so Gmail and Apple Mail render their own
native Unsubscribe button. It posts to
`POST /api/v1/subscribe/unsubscribe/:token/one-click` from the mail
provider's servers, with no `Origin` header — see the third relaxation
class in `src/lib/cors.ts`. The human landing page at
`GET /api/v1/subscribe/unsubscribe/:token` also now lists the address's
other threads, with per-row buttons and an unsubscribe-from-all.

**Embedders need no wiring for any of this.** It is all inside the widget
and the emails; there are no new `data-*` attributes and no new env vars.

### Posting a comment (since v2.20.0)

A successful post renders straight from the `201` the server already
returns, and fetches nothing back.

`POST /api/v1/comments` echoes the new comment in full, so the widget
builds the node from that echo and inserts it into the page it is
already showing. Before v2.20.0 it discarded the echo and re-fetched the
first page of the thread instead, which had two costs an embedder can
see:

- **A second request per comment.** Posting now costs one.
- **On a thread longer than one page, your own comment could land
  nowhere.** A reload fetches page *one*, and under the oldest-first
  sort a new top-level comment belongs on the *last* page — so it
  simply was not in the response that replaced the page.

The reader's own comment carries a subtle accent (`.gr-thread`
`[data-posted]`, styleable like everything else in §5) for as long as it
is on screen. That is deliberate rather than decorative: under
oldest-first and top-first its **position is provisional**. It is
inserted where the reader is looking — last under `old`, first under
`new` and `top`, nested under its parent for a reply — and the next
response that has an opinion puts it where the sort actually places it:
a reload, or a Load More page that turns out to contain it, moves the
node into the server's order rather than leaving the guess standing.
Marking it keeps that from reading as a claim about thread order.

Nothing about this is optimistic. The comment is only drawn after the
server accepts it, and it is drawn with the status the server assigned —
a post held by moderation renders with its "Pending approval" badge, not
as approved-then-corrected. Whether a comment is held is a server
verdict (muted words, Akismet, Workers AI, first-comment hold), so it is
not something the widget could have guessed.

Because the page is no longer replaced, **scroll position and every open
form survive a post**. The widget falls back to the pre-v2.20.0 reload —
the same way the mount falls back on a 404 (§3), and costing the same
second request it always did — whenever it cannot place the comment
honestly:

- the echo is missing a field the renderer needs (a widget bundle newer
  than the Worker it talks to);
- the comment was a reply and its parent is not on the rendered page;
- the reply flattens onto a tier whose remaining replies are still
  behind a "Show N more replies" button, so where it belongs in that
  tier is not known yet.

So posting costs one request in the ordinary case and two in those.

### Markdown preview (since v1.10.0)

The composer (and the reply/edit forms) include a **Write | Preview** tab
strip and a formatting toolbar (bold, italic, link, code, quote, list).
The tab strip implements the full WAI-ARIA tabs pattern: real tabpanels
wired via `aria-controls`/`aria-labelledby`, a roving tabindex, and
Arrow/Home/End key navigation with *manual* activation (arrowing onto
Preview does not fetch; Enter/Space or click does).
Preview renders server-side via `POST /api/v1/preview` `{body}` →
`{html}`, using the *same* allowlist sanitizer as stored comments — so
what you preview is byte-identical to what gets posted, with no
client-side markdown library and no XSS divergence. The endpoint is
public but rate-limited; no auth required.

### Deleting your own comment (since v2.9.0)

Delete asks for confirmation **in place**: the button becomes
"Delete this comment? [Delete] [Cancel]" in the same row. Focus lands on
Cancel, and `Escape` backs out. Before v2.9.0 this was `window.confirm()`,
which is suppressed entirely in some webviews and in cross-origin iframes
without user activation — where the button appeared to do nothing.

### Comment length (since v2.9.0)

A comment body is capped at **10,000 characters**. This is a constant, not
an operator setting — but `/api/v1/config` reports it as `max_body_chars`,
and the composer counts down against it, so the two can never disagree.
The counter stays hidden until the last 500 characters and turns red past
the ceiling. Over-long bodies are still rejected server-side
(`err.body.too_long`); the counter is a warning, not the enforcement.

### Composer keyboard shortcuts (since v2.9.0)

Inside any composer — top-level, reply, or edit:

| Keys                 | Does                                            |
| -------------------- | ----------------------------------------------- |
| `Cmd`/`Ctrl` + `Enter` | Posts the form you are in.                    |
| `Escape`             | Closes a reply or edit box, discarding its draft. The top-level composer has nothing to back out to and ignores it. |

Bound on the form, so they work from the name and email fields too, not
just the textarea. Both are suppressed while an IME composition is
active. `Escape` does not propagate to the host page — closing a reply
box will not also close a lightbox or drawer you have open around it.
The hint under the box is hidden on touch devices.

### Composer sizing (since v2.0.3)

Composers open at a minimum height and **grow to fit their content** —
while you type, when a saved draft is restored, and when the edit box
finishes loading the comment you're editing. Growth is capped at 60% of
the viewport so the Save/Cancel row never leaves the screen; past the cap
the box scrolls. Dragging the resize grip pins that box at your height and
turns auto-sizing off for it.

Before v2.0.3 the edit box opened at ~3 lines regardless of how long the
comment was, because the prefill (`GET /api/v1/comments/:id/source`) lands
after mount and CSS `min-height` had already decided the height (#52).
Widget width is unchanged and still host-controlled — set `max-width` on
the mount element; see docs/THEMING.md.

### Pagination and reply collapsing (since v1.11.0)

The thread no longer dumps every comment into the page at once. Three
operator-tunable settings (Settings → Display & pagination, or the
`COMMENTS_PER_PAGE` / `REPLIES_PER_THREAD` / `AUTO_COLLAPSE_DEPTH` env vars —
see AGENTS-OPERATE.md §5) control the volume:

- **Top-level paging.** The list loads `COMMENTS_PER_PAGE` threads (default
  **25**) with a **"Load older comments"** button that appends the next batch.
  Paging is server-side and cursor-based; every sort paginates,
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

- **Reply depth cap.** A reply nested more than **8** levels deep is rejected
  server-side with HTTP 400 and `err.parent.too_deep`. It exists because an
  unbounded chain made the whole thread un-renderable. Each node in the list
  response carries a `can_reply` boolean computed from that same rule, and the
  widget shows its Reply button on that flag — so the UI dead-ends exactly where
  the server does, and never offers a reply the cap would reject. It answers the
  depth question only: a closed thread, a deleted parent or a rate limit can
  still refuse a reply to a `can_reply: true` node. Existing deeper rows (from a
  Disqus import, say) still render; they arrive with `can_reply: false`.

  Note this is independent of the **display** flatten threshold of 4 levels:
  replies past it stop indenting and render flat with an `@name` prefix, but
  stay repliable up to the cap. Do not infer reply eligibility from a node's
  `depth` — past the flatten point every node reports `depth: 4` regardless of
  how deep it actually is.

Reply collapsing is **purely client-side** — the replies arrive in the single
list response and the widget folds them. There is no `data-*` per-page
override; these are instance-wide. One backstop applies to that response: a
single page of the tree pulls at most 2000 rows out of the database, and a
thread past that is truncated (and logged) rather than allowed to time the
request out. Real threads don't reach it. The new affordances inherit the existing
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
| `--garrul-bg`         | `transparent` (auto light); `#12161a` dark; `#fff` pinned light | Widget background                      |
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
| `--garrul-surface`    | `#f7f8fa`                                                | Raised surface fill: composer card, error/notice box, code blocks and inline code |
| `--garrul-hover`      | `#eef0f3`                                                | Hover background on toolbar/icon buttons |
| `--garrul-accent-hover` | `#1d4ed8`                                              | Submit button hover background         |
| `--garrul-vote-active` | `--garrul-badge-bg`                                     | Active vote / reaction highlight (defaults to the badge background) |
| `--garrul-shadow`     | `0 1px 2px rgba(0,0,0,.06)`                              | Box-shadow on raised surfaces          |
| `--garrul-motion`     | `120ms`                                                  | Transition duration; `0ms` opts out    |

### Presets (since v2.9.0)

For a different look without picking colors by hand, set `data-preset`
on the host element:

```html
<div id="garrul" data-slug="hello-world" data-api="{{INSTANCE_URL}}"
  data-preset="soft"></div>
```

| `data-preset` | Look                                                     |
| ------------- | -------------------------------------------------------- |
| absent        | Default palette — blue accent, 6px corners, soft shadow  |
| `minimal`     | Monochrome, no shadow, near-square corners               |
| `soft`        | Rounded 12px, violet accent, tinted surfaces             |
| `contrast`    | High contrast, hard borders, no shadow (WCAG AA pairs)   |

Each preset has a light and a dark half, so it composes with `data-theme`
and with `prefers-color-scheme` rather than replacing them. Any
`--garrul-*` override you set still wins over the preset. Precedence:
**host override > preset > `data-theme` > OS preference > light**.

The iframe fallback (§6) takes the same thing as `?preset=` on the frame
URL — which is the only styling available there, since a host page cannot
reach into another document's custom properties.

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
| `light`            | Always light; paints a concrete `#fff` background (a pinned-light widget can land on a dark host, where transparent fails contrast) |
| `dark`             | Always dark                             |

Host `--garrul-*` overrides still win at every theme level, so the table above
remains the supported customization surface. For the full reference and
stability policy, see `docs/THEMING.md`.

The resolved theme also sets `color-scheme`, so browser-painted UI inside the
widget — `<select>` popups, scrollbars, caret and focus rings — follows it
rather than staying light on a dark page. The iframe route does the same from
its `?theme=` parameter.

### Code blocks in comments (since v2.5.1)

Fenced code blocks render as a tinted box filled with `--garrul-surface`, and a
long line **scrolls inside that box**. It does not widen the widget, and it does
not push the host page into horizontal scroll — which is what happened before
v2.5.1, where a single long line in a comment made the whole host page scrollable
sideways on a phone.

Inline `code` gets the same tint and breaks on long tokens (URLs, hashes) rather
than forcing the row wider.

If you are theming a dark host, `--garrul-surface` is the variable to set: it
fills the composer card, notice boxes, and now code as well.

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
**The origin you pass must be listed in the Worker's `ALLOWED_ORIGINS`**
— anything else gets no `postMessage` at all, and there is no
`document.referrer` fallback. That same list is what the page's CSP
`frame-ancestors` permits, so an unlisted host can't frame `/embed/*`
either. The iframe variant gives up host-page CSS-variable theming (the
iframe is a separate document) but inherits everything else.

`?lang=` is the iframe's equivalent of `data-lang` — it lands on both
the frame's `<html lang>` and the widget inside it. There is no
`<html lang>` to inherit here (the frame *is* the document), so pass it
explicitly when the surrounding page isn't in English. The widget gets
the tag verbatim; the frame's `<html lang>` gets the *matched* locale
(`de-AT` → `de`, an unknown tag → `en`), so the document never claims a
language it isn't rendering:

```js
src.searchParams.set("lang", "de");
```

## 7. Authentication flow

Garrul supports five OAuth providers: **GitHub**, **Google**,
**Facebook**, **X** (provider slug `twitter`), and **Discord**. The
operator decides which are enabled by setting the matching client ID +
secret in `wrangler.toml` / secrets — a provider with no credentials
simply doesn't appear. Generic OIDC is v2 backlog.

What an end user sees when signing in from the embedded widget:

1. They click "Sign in with GitHub" (or any other enabled provider) in
   the comment form.
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

**COOP on the host page:** if the embedding page sends
`Cross-Origin-Opener-Policy: same-origin`, the browser puts the
cross-origin popup in its own browsing context group, `window.opener` is
`null` there, and step 5 never happens. The popup still says "Signed
in" — it has no way to detect the severed opener — so the failure is
silent. The widget covers for it by watching its own handle on the popup
and re-checking `/api/v1/auth/me` once that window closes (COOP severs
the popup's `opener`, not the opener's `popup.closed`), but that only
works when the host and the Worker share a registered domain (same
cookie partition). Advise the
integrator to serve `same-origin-allow-popups` instead: it keeps the
opener for popups the page itself opens. Not needed if the host sends no
COOP header at all.

**Session cookie**: `__Host-garrul_sess`, 32 random bytes, `HttpOnly;
Secure; SameSite=None; Partitioned; Path=/`. KV-backed lookup, 30-day TTL
refreshed on use. No JWT. The `Partitioned` flag is required for
cross-site embeds to work in Chrome's 3PC phase-out and Safari ITP —
don't strip it. The `__Host-` prefix binds the cookie to the exact host
that set it, so a sibling subdomain can't plant a session id; it needs
`Secure` and `Path=/`, which is why a `wrangler dev` instance over plain
HTTP uses the unprefixed `garrul_sess` instead.

**Endpoints integrators may call client-side**: `GET /api/v1/auth/me`
returns the current session user (or `{user:null}`); `GET
/api/v1/bootstrap?slug=…` returns the same user under a `user` key
alongside the rest of the mount payload (see "The mount request" in
section 3); `POST /api/v1/auth/signout` revokes the KV session and
clears the cookie. All three go through the same session middleware as
the comment routes.

A banned or erased identity still gets a `user` from both read
endpoints — that field is identity, not authorization. What a banned
reader cannot do is write; the POST paths enforce that. The one
difference is `bootstrap`'s `subscription` section, which is omitted
for an identity that may not act, because `/api/v1/subscribe/mine`
answers those callers a 403 and there is no 403 to return inside a 200
envelope.

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

**Signed-in posting normally skips the challenge**, since an OAuth
session already costs an attacker an account. Operators who want a
challenge on *every* comment set `TURNSTILE_ALWAYS = "true"` (or flip
"Challenge signed-in commenters too" on `/admin/settings`); the widget
then renders Turnstile for signed-in readers as well and the Worker
requires a token from them. It does nothing unless both Turnstile
credentials are configured — without the site key the widget could not
render a challenge to satisfy it, and without the secret the Worker
could not verify one.

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
- The **`User-Agent` header** as sent, alongside the hashed IP, for spam
  and abuse investigation. Cleared by the same
  `IP_HASH_RETENTION_DAYS` sweep and by user erasure.
- For email-notification subscribers: the email address and an opaque
  unsubscribe token.

What's **not** stored: raw IPs, browser fingerprints, referrer chains,
tracking-pixel data, anything from the OAuth provider beyond name +
email + avatar + provider ID.

Cookies set by Garrul:

- `__Host-garrul_sess` — session lookup ID. `HttpOnly; Secure;
  SameSite=None; Partitioned; Path=/`. No tracking cookies are set.

For the operator-facing privacy posture (retention policy, deletion
flow, Cloudflare/Resend subprocessor disclosure, GDPR/COPPA notes),
point integrators at the operator's privacy page. A ready-to-edit
template lives at `docs/privacy-policy.template.md` in this repo —
the operator publishes a filled-in version on their own site and
links to it from the embed page's footer or `/privacy` route.

**Compliance paperwork**, for an operator who needs more than a policy
template, is in `docs/compliance/`: a personal-data inventory that maps
one-to-one onto a GDPR Art. 30 record, the data-subject rights mapped to
the mechanisms that serve them, the CCPA/CPRA category vocabulary, a
subprocessor register, and a runbook for answering an access or erasure
request. It describes what the software does; the operator is the
controller and owns the legal call. Garrul is not "GDPR compliant" —
compliance is a property of a deployment.

One thing that lands on the **host page**, not the widget: a
notice-at-collection. The widget renders no privacy notice of its own, so
an operator relying on CCPA § 1798.100(a) or GDPR Art. 13 needs a line
near the comment form linking to their policy. Worth mentioning when you
wire up an embed.

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

### Signed in, but the widget doesn't notice until reload

Almost always `Cross-Origin-Opener-Policy: same-origin` on the host page
severing the popup's opener (see §7). Check it with
`curl -sI <host page> | grep -i cross-origin-opener` and switch the value
to `same-origin-allow-popups`. The other candidate is a host origin
missing from `ALLOWED_ORIGINS`, which leaves the Worker without a safe
`postMessage` target.

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

The Worker enforces the mirror image of that last bullet: both `/embed/*`
pages send their own CSP `frame-ancestors` built from `ALLOWED_ORIGINS`,
so **a host site must be in `ALLOWED_ORIGINS` to frame them at all** —
in either mode, since the script-tag embed also mounts the Turnstile
frame. A missing entry shows up as a browser console refusal to frame,
not an HTTP error. (Under `ENV=dev` framing is unrestricted, matching the
CORS gate.)

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
`reactions: { slug: { kind: count } }` — e.g. render "12 💬 · 30 🔥".
The `kind` keys are the vocabulary listed under *Voting and reactions*
above; note that `like` became `fire` in v2.10.0, so a listing page
reading `reactions[slug].like` needs updating.

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
  widget reads `data-slug`, `data-api`, `data-title`, `data-url`,
  `data-published`, `data-theme`, and `data-lang` off the host element
  at runtime.
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
- `docs/compliance/` — personal-data inventory, GDPR and CCPA/CPRA
  guides, subprocessor register, DSAR runbook. Operator-facing; see §9.
- `examples/` — runnable per-framework starter projects
  (`astro/`, `hugo/`, `jekyll/`, `wordpress/`, `plain-html/`, `iframe/`).
- `AGENTS-OPERATE.md` — operator-side guide. Read this too if you are
  both embedding AND running the Worker.
