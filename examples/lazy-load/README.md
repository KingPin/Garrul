# Garrul — lazy-loading the widget

By default, the embed script runs as soon as the page parses, which
fires three Worker requests per pageview before the reader has scrolled
anywhere near the comments (`/api/v1/config`, `/api/v1/auth/me`,
`/api/v1/comments?slug=...`). On a busy blog where most visitors bounce
without engaging, that's the bulk of your Cloudflare Worker usage.

Two patterns to defer it. The first is what we recommend.

## 1. Scroll-into-view (recommended)

Load `embed.js` only when the comments container is about to enter the
viewport. Engaged readers — the ones who scroll to the bottom — still
get a seamless experience. Bouncers cost you nothing.

```html
<section id="comments">
  <h2>Comments</h2>
  <div
    id="garrul"
    data-slug="my-post-slug"
    data-api="https://comments.example.com"
    data-title="My post title"
    data-url="https://example.com/my-post/"
  ></div>
</section>

<script>
  (function () {
    var mount = document.getElementById("garrul");
    if (!mount) return;

    var loaded = false;
    function load() {
      if (loaded) return;
      loaded = true;
      var s = document.createElement("script");
      s.src = "https://comments.example.com/embed.js";
      s.defer = true;
      document.body.appendChild(s);
    }

    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) {
          io.disconnect();
          load();
        }
      }, { rootMargin: "500px 0px" }); // start loading ~half a screen early
      io.observe(mount);
    } else {
      load(); // very old browsers — just load eagerly
    }
  })();
</script>
```

### What you give up

- **Crawler visibility of comment bodies.** Search engines and AI
  crawlers don't scroll, so the comments tree won't be in the rendered
  HTML they see. Garrul mitigates this with two independent surfaces
  that *are* always crawlable: the per-post RSS feed (`/feed/:slug`)
  and the per-comment permalinks (`/c/:id`). If you care strongly about
  comment content being indexed inline with the post, skip lazy-loading
  on that page.
- **Above-the-fold widgets.** Don't use this pattern if the comments
  container is visible without scrolling — the observer will fire
  immediately and you've saved nothing while adding code.

## 2. Click-to-load (only if you really need it)

Render a button; mount the widget only after a click.

```html
<section id="comments">
  <h2>Comments</h2>
  <button type="button" id="garrul-load">Load comments</button>
  <div
    id="garrul"
    data-slug="my-post-slug"
    data-api="https://comments.example.com"
    data-title="My post title"
    data-url="https://example.com/my-post/"
    hidden
  ></div>
</section>

<script>
  document.getElementById("garrul-load").addEventListener("click", function () {
    this.remove();
    document.getElementById("garrul").hidden = false;
    var s = document.createElement("script");
    s.src = "https://comments.example.com/embed.js";
    s.defer = true;
    document.body.appendChild(s);
  });
</script>
```

### Why we don't recommend this

- **Most readers won't click.** Reading existing discussion is a
  passive activity; clicking a button is a commitment. Discussion
  culture decays — newcomers can't see what's already been said, so
  they post duplicates or skip commenting entirely.
- **Looks like comments are disabled.** A "Load comments" button reads
  as "we turned them off" to a lot of readers, even with a count next
  to it.
- **Zero crawler visibility of comments.** Unlike scroll-into-view —
  where the RSS feed and `/c/:id` permalinks still give crawlers a path
  to the content — click-to-load doesn't change what crawlers index
  (they don't click either), but the framing makes the comment section
  feel inert on the page itself.
- **Engagement drops.** "Lurkers reading discussions" is a real and
  valuable cohort. Hiding the thread behind a click filters them out
  before they ever consider replying.

Use this **only** if Worker cost is a hard ceiling (e.g. very high
traffic on the free tier) and you've measured that scroll-into-view
isn't enough.

## How much do you actually save?

A rough sketch — your real numbers will vary:

| Pattern        | Worker requests per pageview          |
| -------------- | ------------------------------------- |
| Default        | ~3 (config + auth/me + comment tree)  |
| Scroll-in-view | ~3 for engaged readers, **0** for bouncers |
| Click-to-load  | **0** unless the reader clicks        |

If your bounce rate at the comments section is high (typical for blog
content), scroll-into-view captures most of the savings without the
UX cost.

## Combining with platform examples

The snippets above are framework-agnostic. To apply to
[Astro](../astro/README.md), [Hugo](../hugo/README.md),
[Jekyll](../jekyll/README.md), or [WordPress](../wordpress/README.md),
replace the inline `<script src="…/embed.js">` in those examples with
the deferred loader from pattern 1.
