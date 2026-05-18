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
- To disable comments on a single page, add `disableComments: true` to
  its front-matter.
- Add your published origin (e.g. `https://yourblog.com`) to
  `ALLOWED_ORIGINS` in the Worker's `wrangler.toml`.
- For `hugo server` local dev, you can either point `garrulApi` at
  `http://localhost:8787` temporarily or add the dev origin
  (`http://localhost:1313`) to `ALLOWED_ORIGINS` alongside prod.
