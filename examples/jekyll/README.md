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
    data-published="{{ page.date | date_to_xmlschema }}"
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
- `data-published` is optional. It anchors age-based auto-close
  (`AUTO_CLOSE_DAYS`) on the post's date instead of the first comment's
  time. `date_to_xmlschema` emits ISO 8601, which is what the widget
  expects; `page.date` comes from the filename date or the `date:`
  front-matter key.
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

## Recent comments list (build time)

Garrul serves a site-wide feed at `GET /feed`. This recipe shows the newest
comments on your home page or sidebar without loading the widget there. It
runs as a step before `jekyll build`, so it works in safe mode (GitHub Actions
builds) and needs no `_plugins`. The step needs `curl` and `jq`, both present
on GitHub-hosted runners.

The feed stays outside the Worker's `/api/*` Origin gate, so a build step with
no `Origin` header can read it. `site` must be an origin listed in
`ALLOWED_ORIGINS`, written without a trailing slash. On a single-origin install, drop `site` from the URL: see
`docs/embedding.md` (Recent comments).

Run this before `jekyll build` (for example as a workflow step):

```bash
FEED="https://comments.example.com/feed?format=json&site=https%3A%2F%2Fblog.example.com"
mkdir -p _data
if curl --fail --silent --show-error --max-time 10 -o feed.tmp "$FEED" \
  && jq -e '.items | type == "array"' feed.tmp > /dev/null; then
  mv feed.tmp _data/recent_comments.json
else
  echo "warning: recent comments unavailable, building without them" >&2
  echo '{"items":[]}' > _data/recent_comments.json
fi
rm -f feed.tmp
```

A network error, a non-2xx status or a body that is not JSON with an `items`
array all write `{"items":[]}` and the build continues.

Render it where you want the list:

{% raw %}
```liquid
{% assign recent = site.data.recent_comments.items | where_exp: "i", "i.url" | slice: 0, 5 %}
{% if recent.size > 0 %}
<ul class="recent-comments">
  {% for c in recent %}
  <li>
    <a href="{{ c.url | escape }}">{{ c._garrul.post_title | default: c.title | escape }}</a>
    <span>{{ c.authors[0].name | escape }}: {{ c.content_html | strip_html | truncatewords: 20 }}</span>
  </li>
  {% endfor %}
</ul>
{% endif %}
```
{% endraw %}

The list refreshes only when the site rebuilds. Add a scheduled CI rebuild
(for example a daily `schedule:` cron in the workflow) to keep it current.
Add `_data/recent_comments.json` to `.gitignore` if the step runs in CI.
