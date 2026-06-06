# Theming Garrul

The Garrul widget mounts inside a Shadow DOM, so host-page styles never
leak in. The **only** supported way to restyle the widget is by overriding
the CSS custom properties listed below.

These names are part of the **public, semver-protected API**. Renaming
or removing any of them is a breaking change.

## How to override

CSS custom properties pierce Shadow DOM, so set them on the host element
(or any ancestor):

```html
<div id="garrul" data-slug="hello-world" style="
	--garrul-accent: #d946ef;
	--garrul-radius: 12px;
"></div>
```

Or in a stylesheet:

```css
#garrul {
	--garrul-fg: #f3f4f6;
	--garrul-bg: #18181b;
	--garrul-input-bg: #27272a;
	--garrul-border: #3f3f46;
	--garrul-muted: #a1a1aa;
	--garrul-accent: #818cf8;
}
```

## Variables

| Variable                  | Default                                  | Used for                              |
| ------------------------- | ---------------------------------------- | ------------------------------------- |
| `--garrul-font`           | system UI stack                          | Font family for the whole widget      |
| `--garrul-font-size`      | `15px`                                   | Base font size                        |
| `--garrul-fg`             | `#1a1a1a`                                | Primary text color                    |
| `--garrul-bg`             | `transparent`                            | Widget background                     |
| `--garrul-muted`          | `#6b7280`                                | Timestamps, "be the first…" message, the reply collapse toggle (`▸`/`▾`) |
| `--garrul-border`         | `#d0d3d8`                                | Input borders                         |
| `--garrul-radius`         | `6px`                                    | Border-radius on inputs and buttons   |
| `--garrul-input-bg`       | `#fff`                                   | Input + textarea background           |
| `--garrul-accent`         | `#2563eb`                                | Submit button background              |
| `--garrul-accent-fg`      | `#fff`                                   | Submit button text                    |
| `--garrul-link`           | `#2563eb`                                | Link color in comment bodies, the "Show N more replies" / "Load older comments" buttons |
| `--garrul-error`          | `#b91c1c`                                | Error message color                   |
| `--garrul-badge-bg`       | `#e0e7ff`                                | "Verified" badge background           |
| `--garrul-badge-fg`       | `#1e3a8a`                                | "Verified" badge text                 |
| `--garrul-skel`           | `#e7e9ec`                                | Skeleton-loading placeholder color    |
| `--garrul-notice`         | `#1e6091`                                | Informational notice messages (e.g. a closed thread) |
| `--garrul-surface`        | `#f7f8fa`                                | Raised surface fill: composer card, error/notice box |
| `--garrul-hover`          | `#eef0f3`                                | Hover background on toolbar/icon buttons |
| `--garrul-accent-hover`   | `#1d4ed8`                                | Submit button hover background        |
| `--garrul-vote-active`    | `--garrul-badge-bg`                      | Active vote / reaction highlight (defaults to the badge background) |
| `--garrul-shadow`         | `0 1px 2px rgba(0,0,0,.06)`              | Box-shadow on raised surfaces         |

## Dark mode

The widget ships with a built-in dark palette — hosts no longer have to
override every variable by hand to support dark backgrounds.

**Automatic (default).** With no configuration, the widget follows the
visitor's OS/browser preference via `prefers-color-scheme`. A reader on a
dark system sees the dark palette; a reader on a light system sees light.

**Forced.** Set `data-theme` on the `#garrul` host element to pin a theme
regardless of OS preference:

```html
<div id="garrul" data-slug="hello-world" data-theme="dark"></div>
```

| `data-theme` value      | Behavior                                    |
| ----------------------- | ------------------------------------------- |
| absent / `auto`         | Follow `prefers-color-scheme` (default)     |
| `light`                 | Always light                                |
| `dark`                  | Always dark                                 |

**Precedence (highest wins):**

1. An explicit `--garrul-*` override you set on the host or an ancestor.
2. `data-theme="dark"` / `data-theme="light"` on `#garrul`.
3. The OS `prefers-color-scheme` preference.
4. The built-in light defaults.

Because every theme level resolves through the public `--garrul-*`
variables, **your manual overrides always win** — the "How to override"
stylesheet above (or any subset of it) keeps working unchanged, layering
on top of whichever base theme is active. Override only the variables you
care about; the rest fall back to the active theme's defaults.

## Stability

Any addition to this list is non-breaking. Any rename, removal, or
default change is breaking and requires a MAJOR version bump.

If you find yourself wanting to override something that isn't in the
list — open an issue. We'd rather expand the surface deliberately
than have you hack into shadow DOM internals.
