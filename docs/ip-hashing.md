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

Three places, all of them for the life of the row:

| Location | Written by | Retention |
| --- | --- | --- |
| `comments.ip_hash` | every comment POST | lifetime of the comment row, **including after a soft delete** |
| `comment_reports.reporter_ip_hash` | reader reporting; `UNIQUE (comment_id, reporter_ip_hash)` is the one-report-per-network rule | lifetime of the report row, including after the flags are resolved |
| `users.provider_id` for `provider='anon'` ghosts | first anonymous comment, vote, reaction or page-engagement event from that network | permanent — the ghost row is the anonymous identity |

Votes, reactions and page-engagement rows don't store a hash of their
own; they key on the ghost `users.id`, so the hash reaches them
indirectly through `provider_id`.

There is **no TTL, no scheduled purge and no retention job.** A hash
written on day one is still there on day one thousand. `npm run
db:export` includes all three columns.

Two things are *not* durable and don't need to be reasoned about here:
rate-limit counters live in the edge Cache API with short TTLs, and
request logs never contain an IP or an `ip_hash` at all.

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
the secret is exposed, the only real fix is to clear or overwrite the
stored columns, which today means hand-written SQL against D1.

## What's missing

Stated plainly, because someone will need it:

- No key epoching — no `ip_hash_version` column, so a rotation can't be
  reasoned about per-row and old values can't be lazily re-keyed.
- No retention window — nothing expires an `ip_hash` after the moderation
  value has passed.
- No purge or anonymize path in the admin UI. A deletion request is
  hand-written SQL today.

Key epoching is tracked in
[issue #50](https://github.com/KingPin/Garrul/issues/50). Until it ships, the practical
posture is: keep the secret safe, keep exports encrypted, and don't
promise an IP retention window you have no mechanism to honor.

## See also

- `src/lib/ip-hash.ts` — the single entry point; normalization lives here.
- [`privacy-policy.template.md`](privacy-policy.template.md) — the
  reader-facing wording, which should match this page.
- [`../AGENTS-OPERATE.md`](../AGENTS-OPERATE.md) §5 for the secret,
  §11 for backups and export.
