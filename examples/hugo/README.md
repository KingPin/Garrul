# Garrul + Hugo

Add the widget as a partial. Every post layout pulls it in via
`{{ partial "comments.html" . }}`. Assumes your Worker is at
`https://comments.yourdomain.com`.

## 1. Site config

Add the Worker origin to `hugo.toml` (or `config.toml`) so you can
override per-deployment via `HUGO_PARAMS_GARRULAPI`:

```toml
[params]
  garrulApi = "https://comments.yourdomain.com"
```

## 2. Partial

`layouts/partials/comments.html`:

```go-html-template
{{- $api := .Site.Params.garrulApi -}}
{{- if and $api (not .Params.disableComments) -}}
<section class="garrul">
  <h2>Comments</h2>
  <div
    id="garrul"
    data-slug="{{ .File.ContentBaseName }}"
    data-api="{{ $api }}"
    data-title="{{ .Title }}"
    data-url="{{ .Permalink }}"
    data-published="{{ .Date.Format "2006-01-02T15:04:05Z07:00" }}"
  ></div>
  <script src="{{ $api }}/embed.js" defer></script>
</section>
{{- end -}}
```

## 3. Call it from your post layout

`layouts/_default/single.html`, at the bottom of `<article>`:

```go-html-template
{{ partial "comments.html" . }}
```

## Notes

- `.File.ContentBaseName` is the filename without extension, which is
  what Hugo also uses for default `:filename` permalinks. If you've
  customized `permalinks` in `hugo.toml`, prefer `.RelPermalink |
  strings.TrimPrefix "/"` so the slug is the URL path. Whichever you
  pick, **be consistent** — changing slug strings orphans the existing
  thread.
- `data-published` is optional. It anchors age-based auto-close
  (`AUTO_CLOSE_DAYS`) on the post's front-matter `date` instead of the
  first comment's time. The format string is RFC 3339, which is what the
  widget expects; `.Date.UnixMilli` works too if you prefer epoch ms.
- To disable comments on a single page, add `disableComments: true` to
  its front-matter.
- Add your published origin (e.g. `https://yourblog.com`) to
  `ALLOWED_ORIGINS` in the Worker's `wrangler.toml`.
- For `hugo server` local dev, you can either point `garrulApi` at
  `http://localhost:8787` temporarily or add the dev origin
  (`http://localhost:1313`) to `ALLOWED_ORIGINS` alongside prod.

## Recent comments list (build time)

Garrul serves a site-wide feed at `GET /feed`. This recipe shows the newest
comments on your home page or sidebar without loading the widget there. It
needs **Hugo 0.141 or newer**: from that release the resource returned by
`resources.GetRemote` no longer carries an `.Err`, so errors are caught with
`try`.

The feed stays outside the Worker's `/api/*` Origin gate, so a build with no
`Origin` header can read it. `site` must be an origin listed in
`ALLOWED_ORIGINS`, written without a trailing slash.

Set a finite remote-fetch cache lifetime in `hugo.toml`. Hugo's default for
this cache never expires, so a rebuild on a persistent cache would reuse the
old feed. The global `timeout` bounds each fetch (default `60s`); lower it if
you want a faster failure:

```toml
timeout = "15s"

[caches.getresource]
  maxAge = "5m"
```

`layouts/partials/recent-comments.html`:

```go-html-template
{{- $url := "https://comments.example.com/feed?format=json&site=https%3A%2F%2Fblog.example.com" -}}
{{- $items := slice -}}
{{- with try (resources.GetRemote $url) -}}
  {{- if .Err -}}
    {{- warnf "recent comments: fetch failed: %s" .Err -}}
  {{- else with .Value -}}
    {{- with try (transform.Unmarshal .Content) -}}
      {{- if .Err -}}
        {{- warnf "recent comments: bad JSON: %s" .Err -}}
      {{- else with .Value -}}
        {{- if reflect.IsSlice .items -}}
          {{- $items = .items -}}
        {{- else -}}
          {{- warnf "recent comments: no items array" -}}
        {{- end -}}
      {{- end -}}
    {{- end -}}
  {{- else -}}
    {{- warnf "recent comments: empty response (HTTP error?)" -}}
  {{- end -}}
{{- end -}}
{{- $linked := slice -}}
{{- range $items -}}
  {{- if .url }}{{ $linked = $linked | append . }}{{ end -}}
{{- end -}}
{{- with first 5 $linked -}}
<ul class="recent-comments">
  {{- range . }}
  <li>
    <a href="{{ .url }}">{{ with ._garrul.post_title }}{{ . }}{{ else }}{{ .title }}{{ end }}</a>
    <span>{{ (index .authors 0).name }}: {{ .content_html | plainify | truncate 100 }}</span>
  </li>
  {{- end }}
</ul>
{{- end -}}
```

Call it with `{{ partial "recent-comments.html" . }}`. A network error, a
non-2xx status, bad JSON or a missing `items` array logs a warning and renders
no list. The build still succeeds.

The list refreshes only when the site rebuilds. Add a scheduled CI rebuild
(for example a daily cron) to keep it current.
