# Embedding

The mount element and its `data-*` attributes are documented once, in
[`../examples/README.md`](../examples/README.md): the embed contract, what
each attribute does, and a copy-paste recipe per platform (Astro, Hugo,
Jekyll, WordPress, plain HTML). Start there.

This page covers what those recipes don't: what to allow in a host
Content-Security-Policy, the iframe variant for hosts that can't change
one, the reactions-only bar, which language your readers see, and how to
hand the whole thing to an AI assistant.

## Script tag (default)

```html
<div
  id="garrul"
  data-slug="my-post-slug"
  data-api="https://comments.example.com"
  data-title="My post title"
  data-url="https://example.com/my-post/"
  data-published="2026-09-11T12:00:00Z"
></div>
<script src="https://comments.example.com/embed.js" defer></script>
```

`data-published` is optional. It anchors age-based auto-close (`AUTO_CLOSE_DAYS`) to the article's real publish time; without it the anchor is the first engagement on the thread. It is recorded once, by the request that creates the post row.

## Content-Security-Policy

If your host page sets a CSP, allow the Worker origin. `embed.js`, the
API, and the Turnstile-hosting iframe all live there:

```
script-src  ... https://comments.example.com;
connect-src ... https://comments.example.com;
frame-src   ... https://comments.example.com;
```

`script-src` lets the embed bundle execute, `connect-src` lets it call the
API, and `frame-src` lets the widget mount its same-origin iframe that
hosts the Turnstile anti-spam challenge.

You do **not** need `*.cloudflare.com` in your CSP. The challenge frame is
nested inside ours and governed by its CSP, not yours.

See [`troubleshooting.md`](troubleshooting.md) for symptom-by-symptom
diagnosis, or use the iframe variant below to keep your host CSP untouched
entirely.

## Iframe (CSP-strict hosts)

```html
<iframe
  src="https://comments.example.com/embed/?slug=my-post-slug"
  style="width:100%;border:0;min-height:400px"
></iframe>
```

`/embed/?slug=` is a static page: on an install with the `[assets]` block
and `ALLOWED_ORIGINS` in `wrangler.toml`'s `[vars]`, Static Assets serves
it and an iframe pageview costs the same Worker requests as a script-tag
embed. The older `/embed/my-post-slug` form still works, but the Worker
renders it, so every pageview is one more billed request. The build bakes
`ALLOWED_ORIGINS` into the page's `frame-ancestors`, so redeploy after
changing it; without it in `[vars]` the Worker serves `/embed/?slug=`
itself.

The iframe has no `data-*` attributes of its own, so the post metadata
travels as query parameters instead: `?title=`, `?url=` and
`?published=` land on `data-title`, `data-url` and `data-published`
inside the frame (`?published=` is omitted from the frame when empty).
`?theme=`, `?preset=` and `?lang=` cover the presentation side. Build
the `src` with `URLSearchParams` so the values are encoded.

The iframe page posts content height to the parent via
`postMessage({type:"garrul:height", height})`. See
[`../examples/iframe/index.html`](../examples/iframe/index.html) for a
~10-line auto-resize listener.

Comment permalinks (`#garrul-comment-<id>`) need two more lines of host
script, both in that example. The iframe cannot read the host page's
fragment, so copy it onto the iframe `src` on load and again on
`hashchange` (a fragment-only change does not reload the frame). Also set
`loading` to `"eager"`: a frame left lazy beyond the browser's threshold
never loads, so the comment is never looked up:

```js
var PREFIX = "#garrul-comment-";
if (location.hash.indexOf(PREFIX) === 0) {
  src.hash = location.hash;
  f.loading = "eager"; // a lazy frame below the fold would never look it up
}
f.src = src.toString();
var sent = src.hash; // the fragment the frame holds
var loaded = false;
f.addEventListener("load", function () { loaded = true; });
window.addEventListener("hashchange", function () {
  var isComment = location.hash.indexOf(PREFIX) === 0;
  // Another anchor on the page is none of the frame's business, unless it
  // leaves a comment: the frame then gets an empty fragment, so a later
  // return to that comment is a change it sees.
  if (!isComment && !sent) return;
  sent = isComment ? location.hash : "";
  var next = new URL(f.src);
  next.hash = sent || "#"; // no fragment at all would reload the frame
  if (!loaded) {
    if (isComment) f.loading = "eager";
    f.src = next.toString();
    return;
  }
  // replace(), not a src change: once the frame has loaded, a src change
  // adds a history entry of its own, and Back would undo that instead.
  f.contentWindow.location.replace(next.toString());
});
```

The listener below handles both messages. It accepts only the frame's own
window and origin, and only finite numbers:

```js
var apiOrigin = new URL(f.src).origin;
window.addEventListener("message", function (e) {
  if (e.origin !== apiOrigin || e.source !== f.contentWindow) return;
  var data = e.data;
  if (!data) return;
  if (data.type === "garrul:scroll" && Number.isFinite(data.top)) {
    // Permalink target: bring it into the host page's viewport.
    var y = f.getBoundingClientRect().top + window.scrollY + data.top;
    window.scrollTo(0, Math.max(0, y - window.innerHeight / 3));
    return;
  }
  if (data.type !== "garrul:height") return;
  if (!Number.isFinite(data.height)) return;
  f.style.height = data.height + "px";
});
```

The frame scrolls nothing itself, so it posts
`{type:"garrul:scroll", top}` (to the `parent_origin` only) and the same
listener scrolls the host page to it. Timestamp links open in the top
window (the frame sets `<base target="_top">`); comment-body links keep
`target="_blank"`.

## Reactions bar only

For a page that wants a quick reaction row but no comment thread, set
`data-mode="reactions"`:

```html
<div id="garrul" data-mode="reactions" data-slug="my-post-slug"
     data-api="https://comments.example.com"></div>
<script src="https://comments.example.com/embed.js" defer></script>
```

It renders the same page-level reactions/votes bar that sits atop a
thread — same slug, same counts — and nothing else: no composer, no
comments. The mount costs **one** Worker request
(`/api/v1/bootstrap?slug=…&view=engagement`); the form-token call is
never made because there is no form. The script itself is a static asset,
not a Worker request, on installs with the `[assets]` block.

- Turn on `PAGE_REACTIONS_ENABLED` and/or `PAGE_VOTES_ENABLED` (env or
  admin Settings). With both off the element stays empty and the
  browser console logs one warning saying why.
- The widget doesn't reserve height in this mode; give `#garrul` a
  `min-height` of about `4.5em` if the row must not shift the page.
- One `#garrul` per page, so a page carries the bar *or* the thread.
  The thread already includes the bar.
- Iframe: `/embed/?slug=my-post-slug&mode=reactions`.

## Language

The widget's language is a property of **the site, not the reader**. A
German visitor to an English blog gets an English comment box, because a
German composer under English prose reads as broken. `Accept-Language` and
`navigator.language` are deliberately never consulted.

```html
<div id="garrul" data-slug="my-post" data-lang="de"></div>
```

English plus `de`, `es`, `fr`, `it`, `ja`, `nb`, `nl`, `pl` and `pt` ship —
[the full table is in `i18n.md`](i18n.md#shipped-locales). `nb` and `pl` are
reviewed by native speakers; the rest are **machine-seeded** (LLM output no
native speaker has checked), so those are reachable only through an explicit
`data-lang` and are never picked up automatically from your `<html lang>`. If
you speak one, correcting it is a five-line PR and promotes the locale to
reviewed:
[`../CONTRIBUTING.md`](../CONTRIBUTING.md#translations-wanted).

Resolution order, the iframe variant's `?lang=`, what is and isn't
translated, and how timestamps render: [`i18n.md`](i18n.md).

## Remembered name and email

After an anonymous reader posts, the widget saves their name in the host
page's `localStorage` and fills it in on their next visit. If they ticked
"notify me", it saves that address too. Nothing is sent to the server for this.
A "Not you? Clear saved details" link under the prefilled name deletes it.

If your privacy policy can't cover that, turn it off:

```html
<div id="garrul" data-slug="my-post" data-remember="off"></div>
```

With `off`, the widget saves nothing and deletes any details it saved before.
The iframe variant has no equivalent setting.

## Lazy-loading

The widget fires one Worker request on page load, before the reader has
scrolled. (When the anti-spam timing heuristic is on, the form token is one
more request, made only once the reader focuses the comment box.) On a read-heavy blog that's most of your Cloudflare usage, spent
on bouncers. [`../examples/lazy-load`](../examples/lazy-load/README.md) has
two deferred-loading patterns, a scroll-into-view loader (recommended) and
a click-to-load button, with the trade-offs of each.

## Recent comments

`GET /feed` is a site-wide feed of the newest approved comments across all
posts. It complements the per-post `GET /feed/:slug`.

| URL | Returns |
|---|---|
| `https://comments.example.com/feed` | Atom (`application/atom+xml`) |
| `https://comments.example.com/feed?format=json` | JSON Feed 1.1 (`application/feed+json`, `access-control-allow-origin: *`) |

Parameters:

- `format`: `json` for JSON Feed. Any other value, or none, serves Atom.
- `site`: optional. A bare origin such as `https://blog.example.com`
  (scheme and host, plus a port only when it is not the default; no trailing
  slash), in the browser-serialized origin form (lowercase host). The value
  and the `ALLOWED_ORIGINS` entry must both use that form. It must equal an
  entry of `ALLOWED_ORIGINS`, otherwise the response is `400 invalid site`. With `site`, only comments on that site's posts
  appear and every entry links. Without it (or with an empty `site=`) the feed
  covers the whole install.

On a single-origin install, omit `site`. The install-wide feed is the cheap
query (about 50 index rows). A `?site=` cache miss reads all `posts` rows plus
every comment on that site's posts. The build-time recipes skip items without
a `url`, so they work without `site`.

The feed holds the 50 newest approved comments. It is cached at the edge
(`cache-control: public, max-age=300`). A comment change clears the cache in
the data center that handled it. Other locations can serve a feed up to five
minutes old. The language is the operator's default locale.

JSON shape (`?format=json&site=https://blog.example.com`):

```json
{
  "version": "https://jsonfeed.org/version/1.1",
  "title": "Recent comments",
  "home_page_url": "https://blog.example.com",
  "feed_url": "https://comments.example.com/feed?format=json&site=https%3A%2F%2Fblog.example.com",
  "language": "en",
  "items": [
    {
      "id": "tag:comments.example.com,2026-11-16:comment/01J...",
      "url": "https://blog.example.com/post/#garrul-comment-01J...",
      "title": "Ada commented",
      "content_html": "<p>...</p>",
      "date_published": "2026-11-16T12:00:00.000Z",
      "date_modified": "2026-11-16T12:05:00.000Z",
      "authors": [{ "name": "Ada" }],
      "_garrul": {
        "post_slug": "hello-world",
        "post_title": "Hello world",
        "post_url": "https://blog.example.com/post/"
      }
    }
  ]
}
```

`home_page_url` appears only with `site`. `date_modified` appears only for
edited comments. `_garrul.post_title` is `null` when the post has no title.

The install-wide feed can contain unlinked entries: comments on a post with no
URL, or a URL outside `ALLOWED_ORIGINS`. Such an entry has no `url` and
`_garrul.post_url` is `null`. Skip them when you render a list. A `?site=` feed
always links every entry.

`/feed` sits outside the `/api/*` Origin gate, so a build step with no `Origin`
header can fetch it (`/api/v1/*` answers those with 403). Build-time recipes
that render a list and keep the build green when Garrul is down:
[Astro](../examples/astro/README.md#recent-comments-list-build-time),
[Hugo](../examples/hugo/README.md#recent-comments-list-build-time),
[Jekyll](../examples/jekyll/README.md#recent-comments-list-build-time). The
list refreshes only when the site rebuilds; schedule a CI rebuild to keep it
current.

There is no live "recent comments" widget on purpose. Mounting one on every
page would add a Worker request per pageview and roughly halve the free-tier
capacity (see [Lazy-loading](#lazy-loading)).

## Using an AI assistant

Garrul ships an AI-targeted integration guide at
[`../AGENTS.md`](../AGENTS.md). Once your instance is deployed it's also
served at `https://<your-garrul-host>/AGENTS.md` with embed snippets
pre-filled for your instance. Point your AI at either URL (use
`?format=txt` if it prefers plain text) and it'll have what it needs to
embed Garrul without re-deriving the data attributes, slug conventions or
theming variables from source.

Self-hosters: [`../AGENTS-OPERATE.md`](../AGENTS-OPERATE.md) is the
operator-side counterpart (install, secrets, `ALLOWED_ORIGINS`,
migrations).
