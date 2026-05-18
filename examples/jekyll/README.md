# Garrul + Jekyll

Add the widget as an include. Every post layout pulls it in via
`{% include comments.html %}`. Assumes your Worker is at
`https://comments.yourdomain.com`.

## 1. Site config

`_config.yml`:

```yaml
garrul:
  api: "https://comments.yourdomain.com"
```

## 2. Include

`_includes/comments.html`:

{% raw %}
```liquid
{% if site.garrul.api and page.comments != false %}
<section class="garrul">
  <h2>Comments</h2>
  <div
    id="garrul"
    data-slug="{{ page.slug }}"
    data-api="{{ site.garrul.api }}"
    data-title="{{ page.title | xml_escape }}"
    data-url="{{ page.url | absolute_url }}"
  ></div>
  <script src="{{ site.garrul.api }}/embed.js" defer></script>
</section>
{% endif %}
```
{% endraw %}

## 3. Call it from your post layout

In `_layouts/post.html`, at the bottom of `<article>`:

{% raw %}
```liquid
{% include comments.html %}
```
{% endraw %}

## Notes

- `page.slug` is auto-generated from the post filename (the part after
  the date, sans extension). Stable across rebuilds — but if you rename
  a post file, the slug changes and the existing thread is orphaned.
- To disable comments on one post, add `comments: false` to its
  front-matter.
- Add your published origin (e.g. `https://yourblog.github.io` or your
  custom domain) to `ALLOWED_ORIGINS` in the Worker's `wrangler.toml`.
- GitHub Pages serves Jekyll over `https://<user>.github.io` by default.
  If you want comments to work both there and on a custom domain, list
  both in `ALLOWED_ORIGINS` — the CORS middleware echoes back whichever
  one matches the request.
- For local dev (`jekyll serve` on `http://localhost:4000`), either
  override `site.garrul.api` in `_config.dev.yml` or add the dev origin
  to `ALLOWED_ORIGINS`.
