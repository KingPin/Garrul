# Embedding

The mount element and its `data-*` attributes are documented once, in
[`../examples/README.md`](../examples/README.md): the embed contract, what
each attribute does, and a copy-paste recipe per platform (Astro, Hugo,
Jekyll, WordPress, plain HTML). Start there.

This page covers what those recipes don't: what to allow in a host
Content-Security-Policy, the iframe variant for hosts that can't change
one, which language your readers see, and how to hand the whole thing to an
AI assistant.

## Script tag (default)

```html
<div
  id="garrul"
  data-slug="my-post-slug"
  data-api="https://comments.example.com"
  data-title="My post title"
  data-url="https://example.com/my-post/"
></div>
<script src="https://comments.example.com/embed.js" defer></script>
```

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
  src="https://comments.example.com/embed/my-post-slug"
  style="width:100%;border:0;min-height:400px"
></iframe>
```

The iframe page posts content height to the parent via
`postMessage({type:"garrul:height", height})`. See
[`../examples/iframe/index.html`](../examples/iframe/index.html) for a
~10-line auto-resize listener.

## Language

The widget's language is a property of **the site, not the reader**. A
German visitor to an English blog gets an English comment box, because a
German composer under English prose reads as broken. `Accept-Language` and
`navigator.language` are deliberately never consulted.

```html
<div id="garrul" data-slug="my-post" data-lang="de"></div>
```

English plus `de`, `es`, `fr`, `it`, `ja`, `nl`, `pl` and `pt` ship —
[the full table is in `i18n.md`](i18n.md#shipped-locales). Everything but
English is **machine-seeded** (LLM output no native speaker has checked), so
those are reachable only through an explicit `data-lang` and are never picked
up automatically from your `<html lang>`. If you speak one, correcting it is a
five-line PR and promotes the locale to reviewed:
[`../CONTRIBUTING.md`](../CONTRIBUTING.md#translations-wanted).

Resolution order, the iframe variant's `?lang=`, what is and isn't
translated, and how timestamps render: [`i18n.md`](i18n.md).

## Lazy-loading

The widget fires two Worker requests on page load, before the reader has
scrolled. On a read-heavy blog that's most of your Cloudflare usage, spent
on bouncers. [`../examples/lazy-load`](../examples/lazy-load/README.md) has
two deferred-loading patterns, a scroll-into-view loader (recommended) and
a click-to-load button, with the trade-offs of each.

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
