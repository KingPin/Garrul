# IP hashing: what's stored, for how long, and what leaks

Garrul never stores a raw IP address. Every use goes through
`src/lib/ip-hash.ts`, which HMAC-SHA-256s the client IP with
`IP_HASH_SECRET` as the key and stores the hex digest.

This document is the honest version of that posture: what the hash
protects, what it doesn't, how long it sticks around, and what you can
and can't do about it today. Read it before you publish a privacy
policy, hand a D1 export to anyone, or answer a deletion request.

## What gets hashed

`clientIp()` reads Cloudflare's `cf-connecting-ip` header, then
`normalizeIpForHash()` canonicalizes it before hashing:

| Input | Hashed as |
| --- | --- |
| `203.0.113.7` | `203.0.113.7` — IPv4 goes in verbatim |
| `2001:db8:1:2:3:4:5:6` | `2001:db8:1:2::/64` — IPv6 truncated to its /64 prefix |
| `::ffff:203.0.113.7` | `203.0.113.7` — IPv4-mapped folds back to dotted form |
| `[fe80::1%eth0]` | `fe80:0:0:0::/64` — brackets and zone id stripped |
| anything unparseable | the value as-is, lowercased and trimmed |

IPv6 is reduced to /64 because a residential allocation is a /64 or
larger. Hashing the full address gave one household 2^64 distinct
hashes, which made every defense keyed on the hash unenforceable for
IPv6 clients — rate limits, ghost identity, vote dedup, report dedup.
/64 is the smallest unit you can assume is one subscriber; /48 would
start grouping unrelated customers of the same ISP.

**Consequence to be aware of:** everyone behind one IPv4 address, or one
IPv6 /64, is one identity to Garrul. That is what makes dedup work, and
it is also why a shared or CGNAT address can catch bystanders when you
ban a ghost author.

## Where the hash lands, and for how long

Three places. Two of them can be put on a timer; the third can't.

| Location | Written by | Retention |
| --- | --- | --- |
| `comments.ip_hash` | every comment POST | `IP_HASH_RETENTION_DAYS` if set, else lifetime of the comment row — **including after a soft delete** |
| `reports.reporter_ip_hash` | reader reporting; `UNIQUE (comment_id, reporter_ip_hash)` is the one-report-per-network rule | `IP_HASH_RETENTION_DAYS` if set, else lifetime of the report row, including after the flags are resolved |
| `users.provider_id` for `provider='anon'` ghosts | first anonymous comment, vote, reaction or page-engagement event from that network | permanent — the ghost row *is* the anonymous identity, so no timer touches it |

Votes, reactions and page-engagement rows don't store a hash of their
own; they key on the ghost `users.id`, so the hash reaches them
indirectly through `provider_id`.

`IP_HASH_RETENTION_DAYS` is **off by default**, so on a stock install
none of these three expire and a hash written on day one is still there
on day one thousand. `npm run db:export` includes all three columns
regardless. See [Retention window](#retention-window) below.

Two things are *not* durable and don't need to be reasoned about here:
rate-limit counters live in the edge Cache API with short TTLs, and
request logs never contain an IP or an `ip_hash` at all.

## Retention window

`IP_HASH_RETENTION_DAYS` (Settings → Moderation, or the env var) puts an
expiry on the two sweepable columns. Past the window, the cron pass
clears `comments.ip_hash`, `comments.user_agent` and
`reports.reporter_ip_hash`. `/admin/operator` shows what's pending and
can drain a backlog on demand instead of over the next few cron ticks.

- **Off by default** (`0`). An upgrade never starts erasing data an
  operator didn't ask it to.
- **Range `[0, 3650]`, with a 7-day floor that refuses rather than
  clamps.** A value of 1–6 logs a warning and sweeps nothing, so a
  fat-fingered `1` can't purge nearly everything. The floor lives in the
  sweep and not in the setting's `min` on purpose: `parseIntSetting`
  clamps into `[min, max]`, so a `min` of 7 would have rewritten an
  explicit `0` ("off") into the most destructive value in range.
- **Irreversible.** Setting the window back to `0` stops future sweeps;
  nothing restores what a sweep already cleared.
- **Anchored on the last edit** (`COALESCE(edited_at, created_at)`) for
  comments — an edited comment is live moderation surface, so the clock
  restarts. Reports go on `created_at` alone, deliberately *not* gated on
  `status='resolved'`: an open-and-forgotten report would otherwise keep
  its reporter's hash forever, which is the exact problem the window
  exists to bound.

What you give up in exchange, once a row is past the window: you can no
longer tell that a new comment came from the same network as an old one,
so spotting a returning ban evader by hash stops working past the window,
and a comment whose report has aged out can be reported again by that
network.

### What it does not cover

Anonymous ghost `users.provider_id` is never swept. For a signed-out
visitor that column *is* the account — `(provider, provider_id)` is how a
returning visitor resolves to their existing ghost — so expiring it on a
timer would delete accounts rather than hashes: ghost-author bans would
stop applying and vote / reaction / page-engagement dedup would reset for
every anonymous visitor.

So **a D1 export always carries the full set of ghost identities**, no
matter what the window says. Don't write a privacy policy claiming
otherwise. Clearing them is a per-person decision (**Erase personal
data** on a user's page) or a deliberate operator one (the purge runbook
in [`../AGENTS-OPERATE.md`](../AGENTS-OPERATE.md) §11), never a scheduled
job.

## What the hash actually protects against

It protects against the case where someone reads your database **without
also having `IP_HASH_SECRET`**. Then the column is a pseudonym: it
correlates activity across posts and tables, but it doesn't hand over an
address.

It does **not** protect against someone who has both. The input space is
small and the construction is unsalted:

- **IPv4 is 2^32 candidates.** One pass over the whole space with the
  leaked key builds a complete address→hash table — minutes on a single
  consumer GPU, and reusable against every row in the export, because
  there's no per-row salt.
- **IPv6 /64 is 2^64**, so exhaustive enumeration isn't practical — but
  confirming a *specific* candidate prefix is one HMAC, and real
  allocations cluster inside known ISP prefixes, so targeted enumeration
  is well within reach.

So treat `IP_HASH_SECRET` as a tier-1 secret on the same footing as
`JWT_SECRET`: `wrangler secret put`, never in `wrangler.toml`, never in
a repo, and keep D1 exports off shared storage. A leak of the secret
*plus* an export is a full IP disclosure for every commenter you've ever
had.

## Rotation: what happens, and what it doesn't fix

You can rotate the secret today —
`wrangler secret put IP_HASH_SECRET` — but understand what that does,
because it is not a remediation for a past leak.

Rotation **re-keys future writes only.** Stored hashes are not rewritten,
and there is no epoch or key-version column anywhere, so after a
rotation the three columns above hold a mix of old-key and new-key
values that nothing can tell apart. Concretely:

- Rate-limit and report-dedup buckets stop matching, so limits reset
  once and a previously-reported comment can be reported again.
- A returning anonymous visitor no longer resolves to their existing
  ghost user; they get a new one. Their old comments still render and
  still belong to the old ghost, but the person is no longer recognized
  as the same commenter.
- A ghost-author ban keyed on the old hash stops applying to that
  network. Re-ban from a fresh comment if you need it to hold.
- Imported Disqus authors are keyed the same way, so a re-import after
  rotation creates new ghost rows for them. Comment-level import dedup
  is by Disqus comment id and is unaffected.

And the part that matters most: **rotation does nothing for hashes
already written.** Those stay crackable with the leaked key forever. If
the secret is exposed, the fix is to clear the stored columns *and then*
rotate — the break-glass runbook is
[`../AGENTS-OPERATE.md`](../AGENTS-OPERATE.md) §11.

## What's missing

Stated plainly, because someone will need it:

- **No key epoching.** There's no `ip_hash_version` column, so a rotation
  can't be reasoned about per-row and old values can't be lazily re-keyed.
  After a rotation the stored columns hold a mix of old-key and new-key
  values that nothing can tell apart.
- **Retention doesn't reach ghost identities.** The window covers the two
  columns that are only ever *signals*; the one that is an *identity* is
  out of scope by construction (see above), so it needs the manual purge
  or a per-user erase.

Between them, that's the gap: a retention window shrinks how much history
a leak exposes, every day, whether or not a leak ever happens. It is not
a remediation *for* a leak — for that you still purge and rotate by hand.

There *is* a per-user erase path: **Erase personal data** on
`/admin/users/<id>` (admin-only, audit-logged). It clears the account's
name, email, avatar and `provider_id` — which for an anonymous ghost
author is the `ip_hash` itself — plus the `ip_hash` and `user_agent` on
every comment they wrote and the `reporter_ip_hash` on every report they
filed. Their email subscriptions and any linked Telegram account are
removed and their sessions are revoked. Comment bodies are kept by
default so the thread stays readable; there's a checkbox to blank them
too, for when the comment text itself is the personal data.

That covers a deletion request for one person. It is not a substitute for
the retention window, and on its own it can't answer a leaked secret —
that needs the bulk purge in §11.

Key epoching is tracked in
[issue #50](https://github.com/KingPin/Garrul/issues/50). Until it ships,
the practical posture is: set a retention window you can actually honor,
keep the secret safe, keep exports encrypted, and word your privacy
policy around the two columns the window covers rather than all three.

## See also

- `src/lib/ip-hash.ts` — the single entry point; normalization lives here.
- [`privacy-policy.template.md`](privacy-policy.template.md) — the
  reader-facing wording, which should match this page.
- [`../AGENTS-OPERATE.md`](../AGENTS-OPERATE.md) §5 for the secret,
  §11 for backups and export.
- [`compliance/data-inventory.md`](compliance/data-inventory.md) — the three
  columns in the context of every other store that holds personal data.
- [`compliance/dsar-runbook.md`](compliance/dsar-runbook.md) — read before
  sending anyone a per-user export. It carries their `comments.ip_hash`
  values, so against a recipient who also has `IP_HASH_SECRET` it is an IP
  disclosure, not a hash disclosure.
- [`compliance/gdpr.md`](compliance/gdpr.md) — why a hash is
  pseudonymisation and not anonymisation, and what that costs you under
  Recital 26.
