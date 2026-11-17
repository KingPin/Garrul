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
    data-published={entry.data.pubDate.toISOString()}
  ></div>
  <script src="https://comments.yourdomain.com/embed.js" defer></script>
</section>
```

## Shared component

`src/components/Comments.astro`:

```astro
---
interface Props { slug: string; title: string; published?: Date; }
const { slug, title, published } = Astro.props;
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
    data-published={published?.toISOString()}
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
<Comments slug={entry.slug} title={entry.data.title} published={entry.data.pubDate} />
```

## Recent comments list (build time)

Garrul serves a site-wide feed at `GET /feed`. This component shows the
newest comments on your home page or sidebar without loading the widget
there. The feed stays outside the Worker's `/api/*` Origin gate, so a build
with no `Origin` header can read it. `site` must be an origin listed in
`ALLOWED_ORIGINS`, written without a trailing slash. On a single-origin install, drop `site` from the URL: see
`docs/embedding.md` (Recent comments).

`src/components/RecentComments.astro`:

```astro
---
const feed =
  "https://comments.yourdomain.com/feed?format=json&site=" +
  encodeURIComponent("https://yourblog.com");

let items: any[] = [];
try {
  const res = await fetch(feed, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.items)) throw new Error("no items array");
  items = data.items;
} catch (err) {
  console.warn(`recent comments unavailable: ${err}`);
}

const recent = items.filter((i) => i.url).slice(0, 5);
const excerpt = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#39|quot|lt|gt|amp);/g, (_, e) => ({ "#39": "'", quot: '"', lt: "<", gt: ">", amp: "&" })[e])
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
---
{recent.length > 0 && (
  <ul class="recent-comments">
    {recent.map((c) => (
      <li>
        <a href={c.url}>{c._garrul?.post_title ?? c.title}</a>
        <span>{c.authors?.[0]?.name}: {excerpt(c.content_html)}</span>
      </li>
    ))}
  </ul>
)}
```

A network error, a timeout, a non-2xx status or a body without an `items`
array logs a warning and renders no list. The build still succeeds. The text
is plain: the excerpt strips tags, then decodes the five entities Garrul's
renderer emits (`&#39;`, `&quot;`, `&lt;`, `&gt;`, `&amp;`) in one pass, so
readers see `Don't` and not `Don&#39;t`. Astro escapes the result once, so the
excerpt cannot inject markup.

Use this only on prerendered (static) pages. With `output: "server"` or an
on-demand page, the frontmatter fetch runs on every page view and adds one
Worker request per view, the cost this design avoids.

The list refreshes only when the site rebuilds. Add a scheduled CI rebuild
(for example a daily cron) to keep it current.

## Notes

- The `data-slug` is the unique identifier for the post's comment
  thread. Keep it stable across edits — changing it orphans existing
  comments. The Astro content collection `slug` works well.
- `data-url` is reflected back in email digests and the per-post RSS
  feed, so it should be the canonical permalink (Astro's
  `Astro.url.href` does the right thing on prod, but in `astro dev`
  it'll be `localhost:4321/...` — set a `site:` in `astro.config.mjs`
  so prod builds use the real URL).
- `data-published` is optional. It anchors age-based auto-close
  (`AUTO_CLOSE_DAYS`) on the post's real publish date instead of the
  first comment's. `pubDate` here is whatever your content collection
  schema calls the date field (`z.coerce.date()` gives you a `Date`);
  Astro drops the attribute when the value is `undefined`, so a
  collection without a date needs no special casing.
- For Cloudflare Pages hosting, add your Pages domain (e.g.
  `https://yoursite.pages.dev` and your custom domain) to
  `ALLOWED_ORIGINS` in `wrangler.toml`. The Worker's CORS middleware
  reads this list — anything not in it will get blocked.
- Astro's View Transitions: when navigating to a new post, the embed
  script re-runs and re-mounts on the new `#garrul` element. No extra
  glue needed.
