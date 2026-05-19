---
title: Garrul — AI Integration Guide
audience: AI coding assistant helping a developer EMBED Garrul comments on their site
canonical_url: https://garrul.com/AGENTS.md
self_url: {{INSTANCE_URL}}/AGENTS.md
repo: https://github.com/KingPin/Garrul
version: {{VERSION}}
---

## 1. What Garrul is

Garrul is a self-hosted comment system on Cloudflare Workers. You add it
to a site by dropping a `<div>` plus a `<script>` into a page template;
the widget mounts inside a Shadow DOM and talks to the Worker over the
public HTTP API. This guide is for AI assistants helping a developer
**embed** Garrul. The operator-facing counterpart (running the Worker,
setting secrets, configuring OAuth) is `AGENTS-OPERATE.md`.

## 2. Decide: script-tag vs. iframe

**Default: use the script tag.** It's smaller, themable via CSS custom
properties, and integrates with the host page's typography.

Use the **iframe** alternative only when:

- The host site has a strict CSP that disallows third-party `<script
  src>` and the operator can't whitelist the Worker host.
- The platform (locked-down CMS, sandboxed editor) blocks custom
  inline `<script>` tags but does allow iframes.
- You want hard isolation between Garrul's network activity and the
  host page (the iframe runs at the Worker's origin).

If neither applies, stick with the script tag.

## 3. Script-tag embed

The canonical snippet. Paste this where comments should appear:

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
| `data-slug`  | A stable identifier for THIS post (see section 6).          |
| `data-title` | The post's human title — used in email digests and admin.   |
| `data-url`   | The canonical permalink — reflected in RSS and email.       |

`data-api` is the same on every page; the host element and the `<script
src>` must agree on the Worker origin.

## 4. Iframe embed

For hosts where you cannot inject `<script>`, point an iframe at the
Worker's per-slug embed route and listen for height messages:

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

## 5. Full `data-*` attribute reference

Every attribute the widget reads from the `#garrul` host element
(source: `src/widget/embed.ts`):

| Attribute    | Required | Notes                                                                                       |
| ------------ | -------- | ------------------------------------------------------------------------------------------- |
| `data-slug`  | yes      | Stable thread identifier. Missing slug renders an error in the host element.                |
| `data-api`   | no       | Worker origin override. Defaults to the origin of the script tag (`<script src>`).          |
| `data-title` | no       | Post title; sent on first comment create, surfaces in admin and notification emails.        |
| `data-url`   | no       | Canonical permalink; sent on first comment create, used in RSS and notification emails.     |

The host element MUST have `id="garrul"`; the widget looks it up by ID
and mounts a Shadow DOM on it. One widget per page — multi-thread
layouts aren't supported in v1.

## 6. Slug conventions

`data-slug` is the thread's primary key from Garrul's point of view.
Two rules:

1. It must be **unique** within the instance.
2. It must be **stable** for the lifetime of the page. Changing it
   orphans every comment posted under the old slug.

Per-framework derivations:

- **Astro** — use `entry.slug` from a content collection. It stays
  stable as long as you don't rename the file.
- **Hugo** — use `{{ .File.ContentBaseName }}` (the filename minus
  extension). If you've customized `permalinks` in `hugo.toml`, prefer
  `{{ .RelPermalink | strings.TrimPrefix "/" }}` so the slug tracks the
  URL path. Pick one and stick with it.
- **Jekyll** — use `{{ page.slug }}`. Auto-derived from the post
  filename. Renaming the file changes the slug.
- **WordPress** — use `get_post_field('post_name', get_the_ID())` (the
  post slug). If you ever change a post's permalink, the slug changes
  and comments orphan. If permalinks churn, use the post ID instead.
- **Plain HTML** — you pick. Use a short kebab-case string and never
  change it (e.g. `welcome`, `hello-world`, `2024-launch`).

## 7. Per-framework snippets

### Astro

`src/components/Comments.astro`:

```astro
---
interface Props { slug: string; title: string; }
const { slug, title } = Astro.props;
const url = Astro.url.href;
const apiOrigin = "{{INSTANCE_URL}}";
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

Use it from a post layout: `<Comments slug={entry.slug} title={entry.data.title} />`.
Set `site:` in `astro.config.mjs` so `Astro.url.href` is the prod URL.

### Hugo

`layouts/partials/comments.html`:

```go-html-template
{{- $api := "{{INSTANCE_URL}}" -}}
{{- if not .Params.disableComments -}}
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

Invoke from `layouts/_default/single.html` with
`{{ partial "comments.html" . }}`. Opt-out a single post by adding
`disableComments: true` to its front-matter.

### Jekyll

`_includes/comments.html`:

```liquid
{% if page.comments != false %}
<section class="garrul">
  <h2>Comments</h2>
  <div
    id="garrul"
    data-slug="{{ page.slug }}"
    data-api="{{INSTANCE_URL}}"
    data-title="{{ page.title | xml_escape }}"
    data-url="{{ page.url | absolute_url }}"
  ></div>
  <script src="{{INSTANCE_URL}}/embed.js" defer></script>
</section>
{% endif %}
```

Include from `_layouts/post.html` with `{% include comments.html %}`.
Opt-out a single post with `comments: false` in front-matter.

### WordPress

Child theme `functions.php`:

```php
add_action('wp_enqueue_scripts', function () {
    if (is_singular('post')) {
        wp_enqueue_script(
            'garrul',
            '{{INSTANCE_URL}}/embed.js',
            [],
            null,
            true   // load in footer
        );
    }
});
```

Child theme `comments.php`:

```php
<?php
if (post_password_required()) return;
$slug  = get_post_field('post_name', get_the_ID());
$title = get_the_title();
$url   = get_permalink();
?>
<section id="comments" class="garrul-wrap">
    <h2>Comments</h2>
    <div
        id="garrul"
        data-slug="<?php echo esc_attr($slug); ?>"
        data-api="{{INSTANCE_URL}}"
        data-title="<?php echo esc_attr($title); ?>"
        data-url="<?php echo esc_url($url); ?>"
    ></div>
</section>
```

Disable native WP comments in Settings → Discussion to avoid two comment
forms rendering on the same page.

### Plain HTML

```html
<h2>Comments</h2>
<div
  id="garrul"
  data-slug="welcome"
  data-api="{{INSTANCE_URL}}"
  data-title="Garrul demo post"
  data-url="https://your-site.example/welcome/"
></div>
<script src="{{INSTANCE_URL}}/embed.js" defer></script>
```

That's the whole integration. Replace `welcome` with a stable slug per
page.

## 8. Theming

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

Dark theme starter — override on the host element (one-liner style for
brevity; format however you like):

```html
<div id="garrul" data-slug="hello-world" data-api="{{INSTANCE_URL}}"
  style="--garrul-fg:#f3f4f6;--garrul-bg:#18181b;--garrul-input-bg:#27272a;
    --garrul-border:#3f3f46;--garrul-muted:#a1a1aa;--garrul-accent:#818cf8;
    --garrul-accent-fg:#0b0b0e;--garrul-link:#a5b4fc;--garrul-badge-bg:#312e81;
    --garrul-badge-fg:#c7d2fe;--garrul-skel:#27272a;"></div>
```

For the full reference and stability policy, see `docs/THEMING.md`.

## 9. Common pitfalls

### Origin allowlist

The Worker rejects requests whose `Origin` header isn't in
`ALLOWED_ORIGINS` (set by the operator in `wrangler.toml`). Symptom:
the widget mounts but every API call returns 403. Fix: the operator
adds the embedder's exact origin (scheme + host + optional port) to
the list. Include both prod and any preview/staging origins separately.

### Safari ITP

The OAuth sign-in flow opens a popup; under Safari Intelligent Tracking
Prevention the popup may be blocked, in which case the widget falls
back to a top-level redirect. The user lands at the callback page,
which closes — they may need to navigate back manually. This is
expected behavior; do not try to "fix" it by removing the popup or
the redirect fallback.

### Content Security Policy

If the host site sets a CSP, allow the Worker origin in:

- `script-src {{INSTANCE_HOST}}` — for the embed bundle.
- `connect-src {{INSTANCE_HOST}}` — for the comment + auth API calls.
- `frame-src {{INSTANCE_HOST}}` — only if using the iframe embed mode.
- `img-src` and `style-src` are fine as-is; the widget uses its
  Shadow DOM stylesheet and renders avatars inline as SVG or via the
  OAuth provider's CDN (covered by `img-src https:` or similar).

### Comment counts on listing pages

The widget itself only renders the current page's thread. For an index
or archive page that needs counts next to each post link, hit
`GET {{INSTANCE_URL}}/api/v1/counts?posts=slug-a,slug-b,slug-c` and
replace your link badges client-side. WordPress's native
`comments_number()` will NOT include Garrul comments.

### `*.workers.dev`

Cloudflare gives every Worker a `*.workers.dev` URL. Don't use it in a
production embed: it lacks cookie partitioning guarantees aligned with
a real domain, and Cloudflare considers it a development surface. Map
a custom subdomain (e.g. `comments.yourdomain.com`) and use that for
both `data-api` and the `<script src>`.

## 10. What NOT to do

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
- Don't fall back to `*.workers.dev` for production embeds — map a
  custom subdomain instead.
- Don't render two `#garrul` elements on one page; only the first is
  picked up. If you need multi-thread layouts, that's not a supported
  mode in v1.
- Don't try to style internals via host CSS. Shadow DOM blocks it on
  purpose; use the documented CSS variables.

## 11. Pointers

- `docs/THEMING.md` — full CSS variable reference + stability policy.
- `docs/troubleshooting.md` — operator-side issues that frequently
  surface to integrators as 4xx / 5xx responses or missing comments.
- `examples/` — runnable per-framework starter projects
  (`astro/`, `hugo/`, `jekyll/`, `wordpress/`, `plain-html/`, `iframe/`).
- `AGENTS-OPERATE.md` — operator-side guide. Read this too if you are
  both embedding AND running the Worker.
- `README.md` — short overview and quick-start.
