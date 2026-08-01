# Garrul documentation

Every doc in this repo, grouped by what you're trying to do.

These docs ship with the code. What you're reading matches the tag or
commit you checked out — if you're running an older release, read that
tag's docs rather than `main`.

## Getting it running

| Doc | Covers |
| --- | --- |
| [`../INSTALL.md`](../INSTALL.md) | Full first-time deploy: prerequisites, OAuth apps, Turnstile, `wrangler.toml`, remote migrations, smoke test. Also `## Updating` for `npm run upgrade`, and `## Local development`. |
| [`../README.md`](../README.md) | What Garrul is, feature list, quick local poke-around. |

## Embedding on your site

| Doc | Covers |
| --- | --- |
| [`../examples/README.md`](../examples/README.md) | Copy-paste integrations for Astro, Hugo, Jekyll, WordPress, plain HTML, the iframe variant, and lazy-loading. Start here. |
| [`../README.md#embedding`](../README.md#embedding) | The embed contract: script tag, `data-*` attributes, iframe fallback. |
| [`THEMING.md`](THEMING.md) | CSS variables, dark mode, which names are stable. |
| [`../AGENTS.md`](../AGENTS.md) | AI-targeted integration guide. Also served live at `https://<your-host>/AGENTS.md` with your host pre-filled — point an assistant at that URL. |

## Operating your instance

| Doc | Covers |
| --- | --- |
| [`../AGENTS-OPERATE.md`](../AGENTS-OPERATE.md) | The operator manual: vars vs. secrets, `ALLOWED_ORIGINS`, Turnstile, OAuth providers, email, day-to-day operation, backups, upgrades. |
| [`troubleshooting.md`](troubleshooting.md) | Symptom-by-symptom fixes across setup, embedding, OAuth, cookies/sessions, digests, and performance. |
| [`ANTISPAM.md`](ANTISPAM.md) | What's always on, which optional layers to enable, and how to work the moderation queue. |
| [`webhooks.md`](webhooks.md) | Outbound payload format, signature verification, retries and auto-disable, Slack/Discord/Telegram adapters. |
| [`telegram.md`](telegram.md) | Operator bot: bot creation, secrets, webhook registration, notifications, commands, daily digest. |
| [`ip-hashing.md`](ip-hashing.md) | What `ip_hash` is, the three places it's stored, how long it's kept, what a leaked `IP_HASH_SECRET` exposes, and what rotation does and doesn't fix. Read before publishing a privacy policy or sharing a D1 export. |

## Running a public instance

Fill in your contact details and link these from your site:

| Doc | Covers |
| --- | --- |
| [`privacy-policy.template.md`](privacy-policy.template.md) | Template privacy policy — what Garrul collects, retention, cookies, deletion requests. |
| [`tos.template.md`](tos.template.md) | Template terms of service — acceptable use, content ownership, moderation. |

## Design notes

Not shipped. Read as intent, not as documentation of current behavior.

| Doc | Covers |
| --- | --- |
| [`api-keys-design.md`](api-keys-design.md) | Proposed v2 API keys: wire format, schema, scopes, middleware ordering, open questions. **Not implemented.** |

## Contributing

| Doc | Covers |
| --- | --- |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | How to propose changes, run the test suite, and what CI enforces. |
| [`../CLAUDE.md`](../CLAUDE.md) | Project conventions — stack, layout, and the rules for API versioning, cookies, CSRF, markdown, migrations, logging, and commits. Read before writing code. |
