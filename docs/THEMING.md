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
| `--garrul-muted`          | `#6b7280`                                | Timestamps, "be the first…" message   |
| `--garrul-border`         | `#d0d3d8`                                | Input borders                         |
| `--garrul-radius`         | `6px`                                    | Border-radius on inputs and buttons   |
| `--garrul-input-bg`       | `#fff`                                   | Input + textarea background           |
| `--garrul-accent`         | `#2563eb`                                | Submit button background              |
| `--garrul-accent-fg`      | `#fff`                                   | Submit button text                    |
| `--garrul-link`           | `#2563eb`                                | Link color in comment bodies          |
| `--garrul-error`          | `#b91c1c`                                | Error message color                   |
| `--garrul-badge-bg`       | `#e0e7ff`                                | "Verified" badge background           |
| `--garrul-badge-fg`       | `#1e3a8a`                                | "Verified" badge text                 |
| `--garrul-skel`           | `#e7e9ec`                                | Skeleton-loading placeholder color    |

## Stability

Any addition to this list is non-breaking. Any rename, removal, or
default change is breaking and requires a MAJOR version bump.

If you find yourself wanting to override something that isn't in the
list — open an issue. We'd rather expand the surface deliberately
than have you hack into shadow DOM internals.
