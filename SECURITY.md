# Security Policy

Garrul is a self-hosted comment system. Every deployment is somebody's
own Cloudflare account, holding their readers' comments, email addresses
and hashed IPs — so a vulnerability here lands on operators who mostly
aren't security people and who upgrade by running one command. Reports
are genuinely welcome.

## Reporting a vulnerability

**Please don't open a public issue.**

Use GitHub's private reporting — it's enabled on this repo:

> **[Report a vulnerability](https://github.com/KingPin/Garrul/security/advisories/new)**
> (repo → **Security** → **Advisories** → *Report a vulnerability*)

That opens a private thread only you and the maintainer can see, and it
becomes the advisory if the report is confirmed. If you'd rather use
email, the address is on the maintainer's GitHub profile — but the
advisory flow is preferred, because it keeps the discussion, the fix and
the eventual disclosure attached to one another.

Helpful to include, roughly in order of usefulness:

- What an attacker gets — read another user's data, post as someone
  else, take the instance down, reach the operator's Cloudflare account.
- The affected version (`package.json`, or `/api/v1/health` on a running
  instance) and whether you reproduced it on your own deployment.
- Concrete steps: a request, a payload, a curl line. A working
  proof-of-concept against your own instance is worth more than a
  description, and much more than a scanner's output.
- Anything you already know about the fix.

Please don't test against `comments.garrul.com` or any instance you
don't run. Stand up your own — `npm run setup` gets you one on the free
tier in a few minutes, which is also the environment the bug lives in.

## What to expect

This is a small project with one maintainer, so here's the honest
version rather than an SLA:

| | |
|---|---|
| First reply | Within a few days. If a week passes with nothing, please ping the thread — it means the notification got lost, not that the report was dismissed. |
| Assessment | We'll tell you whether it's confirmed, what severity we think it is, and why. If we disagree with your severity we'll say so and explain, not quietly downgrade it. |
| Fix | Critical and high issues get patched and released as a priority. Lower-severity ones may be batched into the next regular release. |
| Disclosure | Coordinated. We'll agree a date with you, publish a GitHub Security Advisory, and note it in the release body — that's what `npm run upgrade` shows operators before they deploy. |
| Credit | You'll be credited in the advisory and the release notes unless you'd rather not be. Say either way. |

There's no bug bounty. Nothing is for sale here and there's no budget —
this is a hobby project under Apache 2.0.

## Supported versions

Only the latest release is supported. Fixes ship forward, on top of
`main`; there are no maintenance branches for older versions.

If you're behind, `npm run upgrade` will tell you what changed and walk
you through the drift before deploying. Running an old version is the
most likely reason a self-hosted instance is vulnerable to something
already fixed.

## Scope

Anything an untrusted commenter, an untrusted host page, or a hostile
network position can do to an operator's instance is in scope. In
particular, three classes that matter more here than they would in a
typical web app:

- **Cloudflare free-tier quota exhaustion.** Most operators run on the
  free plan, where several limits — notably KV's 1000 writes/day — are
  scoped to the operator's *entire Cloudflare account*, not to this
  Worker. An unauthenticated request that burns a rationed resource is
  therefore an account-wide outage primitive, and we treat it as a real
  vulnerability rather than a performance issue. If you find an endpoint
  where one anonymous request costs the operator a metered write, that's
  a report worth filing.
- **Cross-site embedding.** The widget is loaded by third-party pages
  and relies on partitioned cookies, an `Origin` allowlist and
  `postMessage` origin checks. Anything that lets one host page act for
  another, or lets an arbitrary page act for a configured one, is in
  scope.
- **Operator-facing tooling.** `scripts/setup.sh`, `npm run upgrade` and
  the export/import scripts run on the operator's own machine with their
  Cloudflare credentials loaded. Code execution or credential exposure
  through them counts the same as a Worker vulnerability.

Also in scope as usual: XSS through comment rendering, authentication
and session handling, authorization gaps in the admin surface, SQL
injection, SSRF through webhooks or avatar URLs, and leakage of PII
(emails, raw IPs) into logs, exports or API responses.

**Out of scope:**

- Vulnerabilities in a deployment's own misconfiguration — a missing
  `IP_HASH_SECRET`, a wide-open `ALLOWED_ORIGINS`, secrets committed to
  the operator's own fork. Report the *documentation* gap if the docs
  led them there; that we'll fix.
- Anything requiring an already-compromised admin account or Cloudflare
  account.
- Missing hardening headers with no demonstrated impact, absent
  rate limits on endpoints that cost nothing, and similar
  scanner findings without an attack behind them.
- Denial of service by simply sending a lot of traffic. Quota
  exhaustion *disproportionate* to the traffic sent — one request, one
  metered write — is in scope; volumetric flooding is Cloudflare's
  problem, not ours.
- Social engineering, physical attacks, and issues in Cloudflare's
  platform itself (report those to Cloudflare).

## Notes for operators

If you're running Garrul and want to reduce your exposure:

- Keep up with releases. `npm run upgrade` prints the release notes
  before it changes anything.
- Set every secret `scripts/setup.sh` generates, and don't reuse them
  across instances. `IP_HASH_SECRET` in particular keys the hash that
  stands in for your readers' IP addresses.
- Keep `ALLOWED_ORIGINS` to the sites that actually embed you.
- Treat `.sql` exports as the most sensitive artifact you'll handle —
  they contain every comment body, subscriber address and hashed IP in
  your database.

`AGENTS-OPERATE.md` covers the operational side of all of this in
detail, including what each secret protects and what shows up in logs.
