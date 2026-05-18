# Garrul + Astro

Drop the widget into any Astro layout. Two patterns: per-page (inline)
or shared via a `<Comments>` component.

Both assume your Worker is at `https://comments.yourdomain.com`. Replace
that origin with whatever you used in `wrangler.toml`'s `[[routes]]`.

## Per-page (inline)

```astro
---
// src/pages/blog/[slug].astro
const { entry } = Astro.props;
---
<article>
  <h1>{entry.data.title}</h1>
  <Fragment set:html={entry.body} />
</article>

<section id="comments">
  <h2>Comments</h2>
  <div
    id="garrul"
    data-slug={entry.slug}
    data-api="https://comments.yourdomain.com"
    data-title={entry.data.title}
    data-url={Astro.url.href}
  ></div>
  <script src="https://comments.yourdomain.com/embed.js" defer></script>
</section>
```

## Shared component

`src/components/Comments.astro`:

```astro
---
interface Props { slug: string; title: string; }
const { slug, title } = Astro.props;
const url = Astro.url.href;
const apiOrigin = "https://comments.yourdomain.com";
---
<section class="garrul">
  <h2>Comments</h2>
  <div
    id="garrul"
    data-slug={slug}
    data-api={apiOrigin}
    data-title={title}
    data-url={url}
  ></div>
  <script src={`${apiOrigin}/embed.js`} defer></script>
</section>
```

Use it from any post layout:

```astro
---
import Comments from "../components/Comments.astro";
const { entry } = Astro.props;
---
<Comments slug={entry.slug} title={entry.data.title} />
```

## Notes

- The `data-slug` is the unique identifier for the post's comment
  thread. Keep it stable across edits — changing it orphans existing
  comments. The Astro content collection `slug` works well.
- `data-url` is reflected back in email digests and the per-post RSS
  feed, so it should be the canonical permalink (Astro's
  `Astro.url.href` does the right thing on prod, but in `astro dev`
  it'll be `localhost:4321/...` — set a `site:` in `astro.config.mjs`
  so prod builds use the real URL).
- For Cloudflare Pages hosting, add your Pages domain (e.g.
  `https://yoursite.pages.dev` and your custom domain) to
  `ALLOWED_ORIGINS` in `wrangler.toml`. The Worker's CORS middleware
  reads this list — anything not in it will get blocked.
- Astro's View Transitions: when navigating to a new post, the embed
  script re-runs and re-mounts on the new `#garrul` element. No extra
  glue needed.
