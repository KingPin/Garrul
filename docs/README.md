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
| [`screenshots.md`](screenshots.md) | What it looks like before you deploy it: the widget in light, dark and mobile, plus a page-by-page tour of the admin UI. |

## Embedding on your site

| Doc | Covers |
| --- | --- |
| [`../examples/README.md`](../examples/README.md) | Copy-paste integrations for Astro, Hugo, Jekyll, WordPress, plain HTML, the iframe variant, and lazy-loading. Start here. |
| [`../README.md#embedding`](../README.md#embedding) | The embed contract: script tag, `data-*` attributes, iframe fallback. |
| [`THEMING.md`](THEMING.md) | CSS variables, dark mode, which names are stable. |
| [`i18n.md`](i18n.md) | Which language your readers see and how it's chosen, the shipped locales and which are machine-seeded, what is never translated, and how timestamps render. |
| [`../AGENTS.md`](../AGENTS.md) | AI-targeted integration guide. Also served live at `https://<your-host>/AGENTS.md` with your host pre-filled — point an assistant at that URL. |

## Operating your instance

| Doc | Covers |
| --- | --- |
| [`../AGENTS-OPERATE.md`](../AGENTS-OPERATE.md) | The operator manual: vars vs. secrets, `ALLOWED_ORIGINS`, Turnstile, OAuth providers, email, day-to-day operation, backups, upgrades. |
| [`troubleshooting.md`](troubleshooting.md) | Symptom-by-symptom fixes across setup, embedding, OAuth, cookies/sessions, notification email, and performance. |
| [`ANTISPAM.md`](ANTISPAM.md) | What's always on, which optional layers to enable, and how to work the moderation queue. |
| [`notifications.md`](notifications.md) | **Which channel notifies whom.** Reply notifications by email are built in — the reader flow, the queue-and-cron mechanism, the three settings that turn it on, and how it degrades when you don't. Plus where webhooks and the Telegram bot fit. |
| [`webhooks.md`](webhooks.md) | Outbound payload format, signature verification, retries and auto-disable, Slack/Discord/Telegram adapters. |
| [`telegram.md`](telegram.md) | Operator bot: bot creation, secrets, webhook registration, notifications, commands, daily digest. |
| [`ip-hashing.md`](ip-hashing.md) | What `ip_hash` is, the three places it's stored, how long it's kept, what a leaked `IP_HASH_SECRET` exposes, and what rotation does and doesn't fix. Read before publishing a privacy policy or sharing a D1 export. |

## Running a public instance

Fill in your contact details and link these from your site:

| Doc | Covers |
| --- | --- |
| [`privacy-policy.template.md`](privacy-policy.template.md) | Template privacy policy — what Garrul collects, retention, cookies, deletion requests. |
| [`tos.template.md`](tos.template.md) | Template terms of service — acceptable use, content ownership, moderation. |

## Compliance

You are the controller of the data in your instance. These describe what the
software does so you can fill in your own paperwork; none of it is legal advice,
and none of it claims Garrul "is GDPR compliant" — compliance is a property of a
deployment, not of a codebase.

| Doc | Covers |
| --- | --- |
| [`compliance/data-inventory.md`](compliance/data-inventory.md) | **Start here.** Every store that holds personal data: fields, purpose, lawful basis, retention, whether erasure reaches it, whether the export covers it. Maps onto a GDPR Art. 30 record. |
| [`compliance/gdpr.md`](compliance/gdpr.md) | Controller/processor split, lawful basis per purpose, and Arts. 15/16/17/20/21/7/8/30/32/33 mapped to the mechanisms that serve them. |
| [`compliance/ccpa.md`](compliance/ccpa.md) | The § 1798.140(v) category vocabulary applied to real fields, sensitive-PI status, the "we do not sell or share" position with its reasoning, verification and deadlines. |
| [`compliance/subprocessors.md`](compliance/subprocessors.md) | Who else receives data, when: Cloudflare always, Resend/Akismet/Workers AI/Telegram/webhooks only if you enable them. Ends with a Cloudflare-only minimal-transfer configuration. |
| [`compliance/dsar-runbook.md`](compliance/dsar-runbook.md) | What to do when a request lands: verify, locate, respond — per request type, with the deadlines. |

## Design notes

Not shipped. Read as intent, not as documentation of current behavior.

| Doc | Covers |
| --- | --- |
| [`api-keys-design.md`](api-keys-design.md) | Proposed v2 API keys: wire format, schema, scopes, middleware ordering, open questions. **Not implemented.** |

## Contributing

| Doc | Covers |
| --- | --- |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | How to propose changes, run the test suite, and what CI enforces. |
| [`../SECURITY.md`](../SECURITY.md) | How to report a vulnerability privately, what's in scope, and which versions get fixes. |
| [`../CLAUDE.md`](../CLAUDE.md) | Project conventions — stack, layout, and the rules for API versioning, cookies, CSRF, markdown, migrations, logging, and commits. Read before writing code. |
