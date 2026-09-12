# Backlog Batch 1 (O2, N1, #58 doc half, N4, O1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five independent backlog items as five PRs, then one release (2.27.0): skip the wasted form-token request (O2), make chronological paging correct for imported comments (N1), wire `data-published` into the widget and fix its docs (#58 doc half), isolate widget drafts per Worker origin (N4), and scope the tree page's engagement queries to the comments on the page (O1).

**Architecture:** Every item is a contained change to an existing flow. O2 adds one boolean to the uncached `/api/v1/config` payload and one guard in the widget. N1 changes the chronological keyset cursor from a bare ULID to `<created_at_ms>.<ulid>` and reads the pair in SQL; legacy bare-ULID cursors resolve with one primary-key lookup. #58 adds a DOM-free helper that builds the post metadata for both POST bodies. N4 extracts the draft-storage helpers into a pure module keyed on the API origin. O1 replaces three whole-slug engagement queries with batched `IN (...)` queries over the page's comment ids.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), Vitest (plain node pool, hand-rolled D1/KV stubs, real SQLite via `node:sqlite`), vanilla TypeScript widget built with esbuild (`embed.js` ≤ 30 KB gzip), Biome lint.

**Spec:** No separate spec file. The design was agreed in chat on 2026-09-11 and is recorded in full in this plan (Global Constraints, User decisions, and the per-task Goals). The backlog source is the Obsidian note `Garrul backlog` items O2, N1, 58, N4, O1.

## Global Constraints

- **Bootstrap byte-identity.** Every section of `GET /api/v1/bootstrap` stays byte-identical to its standalone endpoint. `tests/bootstrap.test.ts` diffs them. O2's new field lands only in `buildConfigPayload` so both paths carry it.
- **No cache headers on `/config` or `/bootstrap`.** O2 relies on this: a toggle of `SPAM_HONEYPOT_MIN_MS` or the secret shows up on the next mount.
- **`/api/v1/comments/form-token` is never folded into bootstrap.** O2 only skips the request; it does not move the token.
- **Tree cache key is canonical.** Every cursor is decoded and re-encoded before it becomes part of `treeCacheKey(...)`. Empty cursor pages are never stored. N1 must keep both rules; the legacy-cursor lookup runs before the cache key is computed.
- **Response shape is unchanged** for `/comments`, `/bootstrap`, and the POST create endpoints. Only `next_cursor`'s string format changes (N1), and the widget treats it as opaque.
- **No per-request KV writes.** Nothing in this batch touches KV.
- **Widget budget:** `npm run size` must pass (≤ 30 KB gzip; baseline ≈ 20.3 KB).
- **Widget pure modules** (`src/widget/boot.ts`, new `src/widget/drafts.ts`) compile under `tsconfig.widget.json` (`"types": []`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) and import nothing from `src/i18n/` or `src/lib/`.
- **Docs-sync gate.** Every PR here touches `src/widget/` or `src/routes/api.comments.ts`, so every PR must edit `AGENTS.md` or `AGENTS-OPERATE.md` (each task below includes that edit). No env-var names change, so the human gate does not fire.
- **Conventional commits**, one PR per item, atomic commits, KingPin identity, no AI co-author trailers.
- **Pre-PR check for every PR:** `npm run lint && npm run typecheck && npm test && npm run manifest:check && npm run build && npm run size`.
- **Doc wording for `data-published` (#58):** the widget sends it on every comment create; the server records it only on the request that creates the post row; it is immutable after that; the only repair path today is direct D1 SQL until the admin edit surface (separate backlog item, code half of 58) ships.

**User decisions (already made):**

- "#58 doc half" = **wire the widget to read `data-published` and send `post_published`, and fix the docs**. No server change, no admin edit surface in this batch.
- N1 = **query + cursor fix only**. The importer is untouched; imported rows keep fresh ULIDs and historical `created_at`.
- Delivery = **one PR per item, one release (2.27.0) at the end**. Merge order: O2, N1, #58, N4, O1.
- Plan location = **repo `docs/superpowers/plans/`**, committed in the O2 PR.

---

## File map

| Item | Create | Modify | Tests |
| --- | --- | --- | --- |
| O2 | `tests/api-config-form-token.test.ts`, `tests/widget-form-token.test.ts` | `src/routes/api.config.ts`, `src/widget/boot.ts`, `src/widget/embed.ts`, `AGENTS.md`, `AGENTS-OPERATE.md`, `CLAUDE.md` | new files + `tests/bootstrap.test.ts` (unchanged, auto-covers) |
| N1 | — | `src/db/queries.ts`, `src/routes/api.comments.ts`, `AGENTS.md`, `tests/queries-comments-realdb.test.ts`, `tests/comments-pagination.test.ts` | both listed test files |
| #58 | `tests/widget-post-meta.test.ts` | `src/widget/boot.ts`, `src/widget/embed.ts`, `AGENTS.md`, `AGENTS-OPERATE.md`, `docs/embedding.md`, `README.md` | new file |
| N4 | `src/widget/drafts.ts`, `tests/widget-drafts.test.ts` | `src/widget/embed.ts`, `AGENTS.md` | new file |
| O1 | — | `src/db/queries.ts`, `src/routes/api.comments.ts`, `AGENTS-OPERATE.md`, `tests/comments-pagination.test.ts` | `tests/comments-pagination.test.ts` |
| Release | — | `package.json`, `package-lock.json`, `release-manifest.json` | `npm run manifest:check` |

Branch names: `feat/o2-form-token-flag`, `fix/n1-chrono-cursor`, `feat/58-data-published-widget`, `fix/n4-draft-key-origin`, `perf/o1-engagement-page-scope`, `release/2.27.0`.

---

## Task 1: O2 server — `form_token_enabled` in the config payload

**Goal:** `GET /api/v1/config` (and therefore bootstrap's `config` section) reports whether `/api/v1/comments/form-token` would answer 200, using the same predicate the route uses.

**Files:**
- Modify: `src/routes/api.config.ts:98-183` (`buildConfigPayload`)
- Create: `tests/api-config-form-token.test.ts`
- Read for reference: `src/routes/api.comments.ts:248-259` (the form-token route's predicate)

**Acceptance Criteria:**
- [ ] `form_token_enabled` is `false` when `SPAM_FORM_TS_SECRET` is unset.
- [ ] `form_token_enabled` is `false` when the secret is set but `spam_honeypot_min_ms` resolves to `0`.
- [ ] `form_token_enabled` is `true` when the secret is set and `spam_honeypot_min_ms` resolves above `0`.
- [ ] `tests/bootstrap.test.ts` still passes (bootstrap's `config` section carries the field because it calls the same builder).

**Verify:** `npx vitest run tests/api-config-form-token.test.ts tests/bootstrap.test.ts` → all green.

**Steps:**

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git pull --ff-only
git checkout -b feat/o2-form-token-flag
```

- [ ] **Step 2: Write the failing test**

Create `tests/api-config-form-token.test.ts`. The harness copies `tests/api-config-locale.test.ts:22-56`: a D1 stub that returns no settings rows, so numbers resolve from env vars and defaults.

```ts
/**
 * GET /api/v1/config — `form_token_enabled`.
 *
 * The widget uses this flag to skip the `/api/v1/comments/form-token`
 * request when that route would 404 anyway. The predicate here must equal
 * the route's own gate (secret present AND spam_honeypot_min_ms > 0); if the
 * two drift, the widget either wastes a request or submits without a token.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { config } from "../src/routes/api.config";
import type { Bindings } from "../src/index";

const kv = () => ({
	get: async () => null,
	put: async () => {},
	delete: async () => {},
});

const app = new Hono<{ Bindings: Bindings }>().route("/", config);

const makeEnv = (extra: Record<string, unknown> = {}) =>
	({
		DB: {
			prepare: () => ({
				bind() {
					return this;
				},
				async all() {
					return { results: [] };
				},
				async first() {
					return null;
				},
			}),
		},
		TREE_CACHE: kv(),
		...extra,
	}) as unknown as Record<string, unknown>;

const getConfig = async (
	extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => {
	const res = await app.request("/", {}, makeEnv(extra));
	expect(res.status).toBe(200);
	return (await res.json()) as Record<string, unknown>;
};

describe("GET /api/v1/config form_token_enabled", () => {
	it("is false with no signing secret", async () => {
		const cfg = await getConfig({ SPAM_HONEYPOT_MIN_MS: "1500" });
		expect(cfg.form_token_enabled).toBe(false);
	});

	it("is false when the secret is set but the minimum is 0 (the default)", async () => {
		const cfg = await getConfig({ SPAM_FORM_TS_SECRET: "k" });
		expect(cfg.form_token_enabled).toBe(false);
	});

	it("is true when the secret is set and the minimum is above 0", async () => {
		const cfg = await getConfig({
			SPAM_FORM_TS_SECRET: "k",
			SPAM_HONEYPOT_MIN_MS: "1500",
		});
		expect(cfg.form_token_enabled).toBe(true);
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/api-config-form-token.test.ts`
Expected: 3 failures, each `expected undefined to be false/true`.

- [ ] **Step 4: Add the field to `buildConfigPayload`**

In `src/routes/api.config.ts`, the returned object in `buildConfigPayload` ends with:

```ts
		community_min_votes: numbers.community_min_votes,
		community_collapse_ratio: numbers.community_collapse_ratio,
	};
```

Change it to:

```ts
		community_min_votes: numbers.community_min_votes,
		community_collapse_ratio: numbers.community_collapse_ratio,
		// Whether `/api/v1/comments/form-token` would answer 200. Same predicate
		// as that route (secret present AND minimum above zero) so the widget can
		// skip the request on installs where it would only ever 404. Config is
		// never cached, so a toggle shows up on the next mount.
		form_token_enabled: !!env.SPAM_FORM_TS_SECRET && numbers.spam_honeypot_min_ms > 0,
	};
```

`env` and `numbers` are already in scope (`buildConfigPayload(env, resolved, locale)` destructures `const { flags, numbers } = resolved;`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/api-config-form-token.test.ts tests/bootstrap.test.ts tests/api-config-locale.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api.config.ts tests/api-config-form-token.test.ts
git commit -m "feat(config): expose form_token_enabled so the widget can skip a guaranteed 404"
```

---

## Task 2: O2 widget — skip the form-token prefetch when the server says it is off

**Goal:** The widget does not request `/api/v1/comments/form-token` when config carries `form_token_enabled: false`. A missing field (older server) keeps today's behavior.

**Files:**
- Modify: `src/widget/boot.ts:50-72` (`ConfigResponse`), add one exported helper after the type
- Modify: `src/widget/embed.ts:741-760` (`prefetchFormToken`), `src/widget/embed.ts:3540-3543` (config consumption)
- Create: `tests/widget-form-token.test.ts`

**Acceptance Criteria:**
- [ ] `formTokenWanted(undefined)`, `formTokenWanted(null)`, `formTokenWanted({})`, `formTokenWanted({ form_token_enabled: true })` all return `true`.
- [ ] `formTokenWanted({ form_token_enabled: false })` returns `false`.
- [ ] When the flag is `false`, `prefetchFormToken` does not call `fetch` and `getFormToken` resolves to `""`.
- [ ] `npm run size` passes.

**Verify:** `npx vitest run tests/widget-form-token.test.ts && npm run typecheck && npm run size` → green.

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `tests/widget-form-token.test.ts`:

```ts
/**
 * The widget skips the form-token request when config says the route would
 * 404. Only an explicit `false` skips: an older server that does not send the
 * field keeps the legacy fetch, because on that server the route may be live.
 */
import { describe, it, expect } from "vitest";
import { formTokenWanted } from "../src/widget/boot";

describe("formTokenWanted", () => {
	it("keeps the legacy fetch when the field is missing", () => {
		expect(formTokenWanted(undefined)).toBe(true);
		expect(formTokenWanted(null)).toBe(true);
		expect(formTokenWanted({})).toBe(true);
	});

	it("fetches when the server says the check is on", () => {
		expect(formTokenWanted({ form_token_enabled: true })).toBe(true);
	});

	it("skips only on an explicit false", () => {
		expect(formTokenWanted({ form_token_enabled: false })).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/widget-form-token.test.ts`
Expected: FAIL, `formTokenWanted` is not exported.

- [ ] **Step 3: Extend `ConfigResponse` and add the helper in `boot.ts`**

In `src/widget/boot.ts`, inside `ConfigResponse` add one line after `community_collapse_ratio?: number;`:

```ts
	community_collapse_ratio?: number;
	form_token_enabled?: boolean;
	locale?: string;
```

Directly after the closing `};` of `ConfigResponse`, add:

```ts
/**
 * Whether the mount should request `/api/v1/comments/form-token`.
 *
 * Only an explicit `false` skips it. A server that predates the field (or a
 * config that failed to load) keeps the legacy request, because on those
 * servers the route may be live and skipping would submit without a token.
 */
export const formTokenWanted = (cfg: ConfigResponse | null | undefined): boolean =>
	cfg?.form_token_enabled !== false;
```

- [ ] **Step 4: Gate the prefetch in `embed.ts`**

In `src/widget/embed.ts`, add `formTokenWanted` to the existing import from `./boot` (keep the import list sorted where the file already is). Then change the block at lines 741-760 from:

```ts
let formTokenPromise: Promise<string> | null = null;
const prefetchFormToken = (apiBase: string): void => {
	if (formTokenPromise) return;
	formTokenPromise = (async () => {
```

to:

```ts
let formTokenPromise: Promise<string> | null = null;
// Set from config at mount. Default true so a mount that never reads config
// (should not happen — mount aborts without one) keeps the legacy fetch.
let formTokenEnabled = true;
const prefetchFormToken = (apiBase: string): void => {
	if (formTokenPromise) return;
	if (!formTokenEnabled) {
		// The server told us the route 404s on this install. Resolve to the same
		// empty token the 404 path returns, without spending the request.
		formTokenPromise = Promise.resolve("");
		return;
	}
	formTokenPromise = (async () => {
```

The rest of `prefetchFormToken` and `getFormToken` stay as they are. All four callers (`buildReplyForm`, reply submit, mount, top-level submit) need no change.

- [ ] **Step 5: Set the flag when config arrives**

In `src/widget/embed.ts` at the config consumption block (line ≈ 3540):

```ts
		const cfg: ConfigResponse | null = boot
			? (boot.config ?? null)
			: await fetchConfig(apiBase, langExplicit, langHint);
		if (cfg) {
```

insert one line between the assignment and the `if`:

```ts
		const cfg: ConfigResponse | null = boot
			? (boot.config ?? null)
			: await fetchConfig(apiBase, langExplicit, langHint);
		formTokenEnabled = formTokenWanted(cfg);
		if (cfg) {
```

- [ ] **Step 6: Run tests, typecheck, size**

Run: `npx vitest run tests/widget-form-token.test.ts tests/widget-boot.test.ts && npm run typecheck && npm run size`
Expected: PASS; size well under 30 KB.

- [ ] **Step 7: Commit**

```bash
git add src/widget/boot.ts src/widget/embed.ts tests/widget-form-token.test.ts
git commit -m "feat(widget): skip the form-token request when config reports it disabled"
```

---

## Task 3: O2 docs + plan commit + PR

**Goal:** Docs describe the new one-or-two-request mount and the `form_token_enabled` field; the plan document is committed; PR opened.

**Files:**
- Modify: `AGENTS.md:200-216`, `AGENTS-OPERATE.md:376-381`, `AGENTS-OPERATE.md:1611-1616`, `CLAUDE.md` ("The mount payload" paragraph)
- Add: `docs/superpowers/plans/2026-09-11-backlog-batch-1.md`, `docs/superpowers/plans/2026-09-11-backlog-batch-1.md.tasks.json`

**Acceptance Criteria:**
- [ ] `grep -n form_token_enabled AGENTS.md AGENTS-OPERATE.md` finds at least one hit in each file.
- [ ] No doc still says the form-token request costs a request "even when that heuristic is off" without the qualifier.
- [ ] Full local CI set passes; PR opened against `main`.

**Verify:** `grep -c form_token_enabled AGENTS.md AGENTS-OPERATE.md CLAUDE.md` → each ≥ 1; `npm run lint && npm run typecheck && npm test && npm run manifest:check && npm run build && npm run size` → green.

**Steps:**

- [ ] **Step 1: AGENTS.md, form-token paragraph (lines 200-208)**

Replace:

```
`/api/v1/comments/form-token` is deliberately **not** folded in, which
is why the mount is two requests and not one. Its signed timestamp
feeds the anti-spam minimum-elapsed-time heuristic, and baking one into
a shared payload would hand every reader the same start time. It is
also an invocation even when that heuristic is off — the route 404s and
the widget treats the absence as "no timing check", but a 404 still
costs a request.
```

with:

```
`/api/v1/comments/form-token` is deliberately **not** folded in, which
is why the mount is two requests and not one when the timing heuristic
is on. Its signed timestamp feeds the anti-spam minimum-elapsed-time
heuristic, and baking one into a shared payload would hand every reader
the same start time. When the heuristic is off (no `SPAM_FORM_TS_SECRET`
or `SPAM_HONEYPOT_MIN_MS` is `0`) the config payload carries
`form_token_enabled: false` and the widget skips the request entirely
(since 2.27.0); before that the route 404'd and the 404 still cost a
request. A widget that sees no `form_token_enabled` field at all (older
server) keeps requesting the token.
```

- [ ] **Step 2: AGENTS.md, lazy-loading paragraph (lines 212-216)**

Replace:

```
The eager `<script defer>` snippet above triggers two Worker requests
per pageview on mount (`/api/v1/bootstrap?slug=…` and
`/api/v1/comments/form-token`) before the reader has scrolled.
```

with:

```
The eager `<script defer>` snippet above triggers one or two Worker
requests per pageview on mount (`/api/v1/bootstrap?slug=…`, plus
`/api/v1/comments/form-token` only when config reports
`form_token_enabled: true`) before the reader has scrolled.
```

Keep the rest of the paragraph unchanged.

- [ ] **Step 3: AGENTS-OPERATE.md, `SPAM_HONEYPOT_MIN_MS` bullet (lines 376-381)**

Replace the sentence fragment:

```
  timestamp is unsigned and forgeable, so `evaluateSpam` skips the check and the
  `/api/v1/comments/form-token` endpoint 404s. The Settings page flags this
```

with:

```
  timestamp is unsigned and forgeable, so `evaluateSpam` skips the check, the
  `/api/v1/comments/form-token` endpoint 404s, and `/api/v1/config` reports
  `form_token_enabled: false` so the widget does not request it. The Settings page flags this
```

- [ ] **Step 4: AGENTS-OPERATE.md, request list (lines 1611-1616)**

Replace:

```
- `GET /api/v1/comments/form-token` — the signed form-render timestamp
  behind the anti-spam timing heuristic, prefetched when the composer
  renders. It stays a separate call on purpose: a shared timestamp would
  hand every reader the same start time and defeat the check. It costs a
  request even with that heuristic off, because the route 404s rather
  than not existing.
```

with:

```
- `GET /api/v1/comments/form-token` — the signed form-render timestamp
  behind the anti-spam timing heuristic, prefetched when the composer
  renders. It stays a separate call on purpose: a shared timestamp would
  hand every reader the same start time and defeat the check. The widget
  skips it when `/api/v1/config` reports `form_token_enabled: false`
  (heuristic off), so on the default install a mount is one request.
```

- [ ] **Step 5: CLAUDE.md, "The mount payload" paragraph**

Replace:

```
A real browser mount costs **two** Worker requests (this plus `/comments/form-token`), which is what sets the ~50k pageviews/day ceiling on the 100k-requests/day free tier.
```

with:

```
A real browser mount costs **one or two** Worker requests: this, plus `/comments/form-token` only when config reports `form_token_enabled: true`. Two requests is what sets the ~50k pageviews/day ceiling on the 100k-requests/day free tier for installs that run the timing heuristic.
```

- [ ] **Step 6: Run the full local CI set**

Run: `npm run lint && npm run typecheck && npm test && npm run manifest:check && npm run build && npm run size`
Expected: all green. `npm run build` regenerates `src/widget/embed.bundled.ts`; include it in the commit if it changed.

- [ ] **Step 7: Commit docs and plan, push, open PR**

```bash
git add AGENTS.md AGENTS-OPERATE.md CLAUDE.md src/widget/embed.bundled.ts
git commit -m "docs: describe form_token_enabled and the one-request default mount"
# `.gitignore:85` lists `docs/superpowers/` as a local AI workspace (commit
# 5ea4778). The user chose to commit this plan with the O2 PR, so force-add the
# two files. Leave the ignore rule in place: it still keeps every other
# superpowers artifact local.
git add -f docs/superpowers/plans/2026-09-11-backlog-batch-1.md docs/superpowers/plans/2026-09-11-backlog-batch-1.md.tasks.json
git commit -m "docs(plans): add backlog batch 1 implementation plan"
git push -u origin feat/o2-form-token-flag
gh pr create --base main --title "feat: skip the form-token request when the timing heuristic is off (O2)" --body "$(cat <<'EOF'
## Summary
- `GET /api/v1/config` (and bootstrap's `config` section) gains `form_token_enabled`, computed with the same predicate as the form-token route.
- The widget skips `/api/v1/comments/form-token` when the field is exactly `false`; a missing field keeps the legacy request.
- Docs updated (AGENTS.md, AGENTS-OPERATE.md, CLAUDE.md). Adds the batch-1 implementation plan under `docs/superpowers/plans/`.

## Test plan
- [x] `tests/api-config-form-token.test.ts` covers the three predicate states
- [x] `tests/widget-form-token.test.ts` covers `formTokenWanted`
- [x] `tests/bootstrap.test.ts` still pins byte-identity
- [x] lint, typecheck, test, manifest:check, build, size
EOF
)"
```

---

## Task 4: N1 queries — chronological paging on `(created_at, id)`

**Goal:** `listThreadRefsForPost` orders and cursors `new`/`old` on `(created_at, id)`, returns `created_at` in each ref, and a new `getThreadCreatedAt` resolves legacy bare-ULID cursors.

**Files:**
- Modify: `src/db/queries.ts:638` (`ThreadRef`), `src/db/queries.ts:658-716` (doc comment + `listThreadRefsForPost`), add `getThreadCreatedAt` after `listThreadRefsForPost`
- Modify: `tests/queries-comments-realdb.test.ts:159-250`

**Acceptance Criteria:**
- [ ] `ThreadRef` is `{ id: string; score: number; created_at: number }` and the SQL selects `created_at`.
- [ ] `new` and `old` paging never skip or repeat a thread when ids and `created_at` disagree.
- [ ] Ties on `created_at` page deterministically (id as tiebreaker).
- [ ] `top` paging is unchanged.
- [ ] `getThreadCreatedAt(db, slug, id)` returns the row's `created_at` for a top-level thread on that slug and `null` otherwise (wrong slug, reply, or missing).

**Verify:** `npx vitest run tests/queries-comments-realdb.test.ts` → green.

**Steps:**

- [ ] **Step 1: Rewrite the false-invariant comment and update the harness in the realdb test**

In `tests/queries-comments-realdb.test.ts` replace lines 163-167:

```ts
	// ULIDs are time-prefixed, so id order tracks created_at order — the
	// invariant every cursor here leans on. Seeded ids agree with their
	// timestamps for exactly that reason; a test that let them disagree would
	// be testing a row shape the writer cannot produce.
	const threadId = (i: number) => `01J${String(i).padStart(23, "0")}`;
```

with:

```ts
	// Ids and created_at are independent. Live writes mint time-prefixed ULIDs
	// so the two usually agree, but imports keep the source's historical
	// created_at under a fresh ULID, so id order says nothing about time order
	// there. Chronological paging therefore cursors on (created_at, id), and the
	// tests below seed both aligned and deliberately misaligned rows.
	const threadId = (i: number) => `01J${String(i).padStart(23, "0")}`;
```

Change `seedThread` to accept an explicit `created_at`:

```ts
	const seedThread = (
		i: number,
		opts: {
			status?: string;
			score?: number;
			parent_id?: string | null;
			created_at?: number;
		} = {},
	) => {
		sqlite
			.prepare(
				`INSERT INTO comments
				   (id, post_slug, parent_id, user_id, body_md, body_html, status,
				    score_up, score_down, depth, created_at)
				 VALUES (?, 'hello', ?, 'u1', 'x', '<p>x</p>', ?, ?, 0, ?, ?)`,
			)
			.run(
				threadId(i),
				opts.parent_id ?? null,
				opts.status ?? "approved",
				opts.score ?? 0,
				opts.parent_id ? 2 : 1,
				opts.created_at ?? 1_700_000_000_000 + i,
			);
	};
```

Change `walk` so the chronological cursor carries `created_at`:

```ts
	const walk = async (sort: "new" | "top" | "old", pageSize: number) => {
		const seen: string[] = [];
		let cursor: { score?: number; created_at?: number; id: string } | null = null;
		for (let guard = 0; guard < 20; guard++) {
			const refs = await listThreadRefsForPost(db, "hello", {
				sort,
				limit: pageSize + 1,
				cursor,
			});
			const page = refs.slice(0, pageSize);
			seen.push(...page.map((r) => r.id));
			const last = page[page.length - 1];
			if (refs.length <= pageSize || !last) break;
			cursor =
				sort === "top"
					? { score: last.score, id: last.id }
					: { created_at: last.created_at, id: last.id };
		}
		return seen;
	};
```

- [ ] **Step 2: Add the failing tests**

Append inside the same `describe` block, after the existing `new` test:

```ts
	it("pages 'new' by created_at when ids disagree with timestamps (imported rows)", async () => {
		// Fresh ULIDs ascend 1..6 but the timestamps are shuffled, the shape an
		// import produces. Expected order is by created_at DESC, not id DESC.
		const stamps = [5, 1, 6, 2, 4, 3];
		stamps.forEach((t, idx) => seedThread(idx + 1, { created_at: 1_700_000_000_000 + t }));
		const seen = await walk("new", 2);
		// created_at 6,5,4,3,2,1 → ids 3,1,5,6,4,2
		expect(seen).toEqual([3, 1, 5, 6, 4, 2].map(threadId));
	});

	it("pages 'old' by created_at when ids disagree with timestamps", async () => {
		const stamps = [5, 1, 6, 2, 4, 3];
		stamps.forEach((t, idx) => seedThread(idx + 1, { created_at: 1_700_000_000_000 + t }));
		const seen = await walk("old", 2);
		// created_at 1,2,3,4,5,6 → ids 2,4,6,5,1,3
		expect(seen).toEqual([2, 4, 6, 5, 1, 3].map(threadId));
	});

	it("breaks created_at ties on id without skipping or repeating", async () => {
		for (let i = 1; i <= 6; i++) seedThread(i, { created_at: 1_700_000_000_000 });
		expect(await walk("new", 2)).toEqual([6, 5, 4, 3, 2, 1].map(threadId));
		expect(await walk("old", 4)).toEqual([1, 2, 3, 4, 5, 6].map(threadId));
	});

	it("returns created_at on every ref", async () => {
		seedThread(1, { created_at: 1_700_000_000_123 });
		const refs = await listThreadRefsForPost(db, "hello", { sort: "new", limit: 5 });
		expect(refs).toEqual([{ id: threadId(1), score: 0, created_at: 1_700_000_000_123 }]);
	});

	it("getThreadCreatedAt resolves a top-level thread on the slug and nothing else", async () => {
		seedThread(1, { created_at: 1_700_000_000_001 });
		seedThread(2, { parent_id: threadId(1), created_at: 1_700_000_000_002 });
		expect(await getThreadCreatedAt(db, "hello", threadId(1))).toBe(1_700_000_000_001);
		expect(await getThreadCreatedAt(db, "hello", threadId(2))).toBeNull(); // a reply
		expect(await getThreadCreatedAt(db, "other", threadId(1))).toBeNull(); // wrong slug
		expect(await getThreadCreatedAt(db, "hello", threadId(9))).toBeNull(); // missing
	});
```

Add `getThreadCreatedAt` to the import from `../src/db/queries` at the top of the file.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/queries-comments-realdb.test.ts`
Expected: the new tests fail (`getThreadCreatedAt` not exported; misaligned order comes back id-ordered; `created_at` missing from refs).

- [ ] **Step 4: Change `ThreadRef`, the query, and add `getThreadCreatedAt`**

In `src/db/queries.ts` line 638:

```ts
export type ThreadRef = { id: string; score: number; created_at: number };
```

Replace the doc comment at lines 658-675 and the function through line 716 with:

```ts
/**
 * One page of top-level thread ids in the requested sort order, plus the two
 * values a keyset cursor needs: net score (for `top`) and `created_at` (for
 * `new`/`old`).
 *
 * Chronological sorts order and cursor on `(created_at, id)`, never on id
 * alone. Live writes mint time-prefixed ULIDs, so id order happens to track
 * time order for them — but imports keep the source's historical `created_at`
 * under a fresh ULID, and a bare-id cursor skips or repeats those rows. id is
 * the tiebreaker for equal timestamps; the pair is a total order because ids
 * are unique.
 *
 * `top` orders on `(score DESC, id DESC)`; unchanged.
 *
 * Cursor semantics: return rows strictly after the cursor position in the
 * requested order. The caller passes `limit = pageSize + 1` to learn whether a
 * next page exists.
 */
export const listThreadRefsForPost = async (
	db: D1Database,
	post_slug: string,
	opts: {
		sort: CommentSort;
		limit: number;
		cursor?: { score?: number; created_at?: number; id: string } | null;
		viewer_id?: string | null;
	},
): Promise<ThreadRef[]> => {
	const visible = visiblePredicate(opts.viewer_id ?? null);
	let cursorSql = "";
	const cursorBinds: (string | number)[] = [];
	if (opts.cursor) {
		if (opts.sort === "top") {
			const score = opts.cursor.score ?? 0;
			cursorSql =
				"AND ((score_up - score_down) < ? OR ((score_up - score_down) = ? AND id < ?))";
			cursorBinds.push(score, score, opts.cursor.id);
		} else if (typeof opts.cursor.created_at === "number") {
			const ts = opts.cursor.created_at;
			cursorSql =
				opts.sort === "old"
					? "AND (created_at > ? OR (created_at = ? AND id > ?))"
					: "AND (created_at < ? OR (created_at = ? AND id < ?))";
			cursorBinds.push(ts, ts, opts.cursor.id);
		}
		// A chronological cursor without created_at is not a position we can
		// name; the route resolves legacy bare-id cursors before calling here
		// (see getThreadCreatedAt), so this branch only guards a programming
		// error and pages from the start.
	}
	const order =
		opts.sort === "top"
			? "(score_up - score_down) DESC, id DESC"
			: opts.sort === "old"
				? "created_at ASC, id ASC"
				: "created_at DESC, id DESC";
	const result = await db
		.prepare(
			`SELECT id, (score_up - score_down) AS score, created_at
			   FROM comments
			  WHERE post_slug = ? AND parent_id IS NULL AND ${visible.sql} ${cursorSql}
			  ORDER BY ${order}
			  LIMIT ?`,
		)
		.bind(post_slug, ...visible.binds, ...cursorBinds, opts.limit)
		.all<ThreadRef>();
	return result.results ?? [];
};

/**
 * `created_at` of one top-level thread on a slug, or null when the id is not a
 * top-level thread of that post. Used once per request to upgrade a legacy
 * bare-ULID chronological cursor to the `(created_at, id)` pair. Scoped to the
 * slug so a cursor minted on one thread cannot probe another.
 */
export const getThreadCreatedAt = async (
	db: D1Database,
	post_slug: string,
	id: string,
): Promise<number | null> => {
	const row = await db
		.prepare(
			"SELECT created_at FROM comments WHERE id = ? AND post_slug = ? AND parent_id IS NULL",
		)
		.bind(id, post_slug)
		.first<{ created_at: number }>();
	return row ? row.created_at : null;
};
```

Keep the existing `visiblePredicate` call and any status filtering exactly as the current function has it; the only SQL changes are the added `created_at` select column, the chronological cursor predicate, and the new function. If the current function's `WHERE` clause carries extra terms beyond `post_slug`, `parent_id IS NULL`, and `visible.sql`, keep them.

- [ ] **Step 5: Run the realdb tests**

Run: `npx vitest run tests/queries-comments-realdb.test.ts`
Expected: PASS, including the pre-existing aligned `old`/`new`/`top`/exclusion tests.

- [ ] **Step 6: Commit**

```bash
git checkout main && git pull --ff-only
git checkout -b fix/n1-chrono-cursor
git add src/db/queries.ts tests/queries-comments-realdb.test.ts
git commit -m "fix(queries): page chronological sorts on (created_at, id) so imported threads are not skipped"
```

(Create the branch before editing if you have not already; the two commands above assume a clean `main`.)

---

## Task 5: N1 route — composite chronological cursor with legacy fallback

**Goal:** `/comments` and `/bootstrap` emit `next_cursor` as `<created_at_ms>.<ulid>` for `new`/`old`, accept that format, accept a legacy bare ULID by resolving it with one lookup before the cache key is computed, and treat an unresolvable legacy cursor as "first page".

**Files:**
- Modify: `src/routes/api.comments.ts:855-871` (cursor decoders), `:975-1150` (`buildTreePage`), import list at `:24-40`
- Modify: `tests/comments-pagination.test.ts` (existing test at `:620-633`, plus new tests)
- Modify: `AGENTS.md` (one sentence near line 388)

**Acceptance Criteria:**
- [ ] `next_cursor` for `new`/`old` matches `^\d{1,13}\.[0-9A-HJKMNP-TV-Z]{26}$`.
- [ ] Sending that cursor back returns the next page with no skip and no repeat, including for rows whose ids and timestamps disagree.
- [ ] A legacy bare-ULID cursor returns the same page as the composite cursor for the same row, and the cached entry is stored under the composite key.
- [ ] A legacy bare ULID that names no top-level thread on the slug returns the first page and writes at most one cache entry (the first-page key).
- [ ] The `top` cursor format and behavior are unchanged.
- [ ] Empty cursor pages are still not cached.

**Verify:** `npx vitest run tests/comments-pagination.test.ts tests/bootstrap.test.ts tests/widget-boot.test.ts` → green.

**Steps:**

- [ ] **Step 1: Update the existing empty-page test and add the new tests**

In `tests/comments-pagination.test.ts`, the test "does not cache an empty cursor page" (line ≈ 620) asserts the sanity key with a bare ULID. Change the last assertion to the composite key (thread 3 has `created_at = 1002`):

```ts
		// Sanity: the same request shape with real rows behind it IS cached, and
		// the legacy bare-ULID spelling lands under the canonical composite key.
		await get(env, `slug=${SLUG}&before=${mkUlid(3)}`);
		expect(
			mockCache.store.has(
				treeCacheKey(REQ_URL, SLUG, "new", 25, `1002.${mkUlid(3)}`).url,
			),
		).toBe(true);
```

Add a seeding helper next to `seedThreads` for misaligned rows:

```ts
/** One top-level thread with an explicit id index and created_at. */
const seedThreadAt = (idIndex: number, createdAt: number) => {
	sqlite
		.prepare(INSERT_COMMENT)
		.run(mkUlid(idIndex), SLUG, null, USER, `c${idIndex}`, `<p>c${idIndex}</p>`, createdAt, 1, 0);
};
```

Add a new `describe` block:

```ts
describe("chronological cursor format (created_at.ulid)", () => {
	const CHRONO = /^\d{1,13}\.[0-9A-HJKMNP-TV-Z]{26}$/;

	// Page size is the `comments_per_page` setting (no query param), so every
	// test here sets it to 2 before building the env, the way the existing
	// cursor tests set it to 10.
	it("emits <created_at>.<ulid> for new and old", async () => {
		seedThreads(5);
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const first = await get(env, `slug=${SLUG}&sort=new`);
		expect(first.next_cursor).toMatch(CHRONO);
		// Page 1 of `new` ends on thread index 4 (created_at 1003).
		expect(first.next_cursor).toBe(`1003.${mkUlid(4)}`);
		const old = await get(env, `slug=${SLUG}&sort=old`);
		expect(old.next_cursor).toBe(`1001.${mkUlid(2)}`);
	});

	it("pages misaligned rows by created_at with no skip or repeat", async () => {
		// ids ascend 1..6, timestamps shuffled: the shape an import produces.
		const stamps = [5, 1, 6, 2, 4, 3];
		stamps.forEach((t, idx) => seedThreadAt(idx + 1, 2000 + t));
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let guard = 0; guard < 10; guard++) {
			const page = await get(
				env,
				`slug=${SLUG}&sort=new${cursor ? `&before=${cursor}` : ""}`,
			);
			seen.push(...page.threads.map((t) => t.id));
			cursor = page.next_cursor;
			if (!cursor) break;
		}
		// created_at 6,5,4,3,2,1 → id indexes 3,1,5,6,4,2
		expect(seen).toEqual([3, 1, 5, 6, 4, 2].map(mkUlid));
	});

	it("accepts a legacy bare-ULID cursor and caches it under the composite key", async () => {
		seedThreads(5);
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const viaLegacy = await get(env, `slug=${SLUG}&sort=new&before=${mkUlid(4)}`);
		const viaComposite = await get(mkEnv(), `slug=${SLUG}&sort=new&before=1003.${mkUlid(4)}`);
		expect(viaLegacy.threads.map((t) => t.id)).toEqual(viaComposite.threads.map((t) => t.id));
		expect(viaLegacy.threads.map((t) => t.id)).toEqual([mkUlid(3), mkUlid(2)]);
		expect(
			mockCache.store.has(treeCacheKey(REQ_URL, SLUG, "new", 2, `1003.${mkUlid(4)}`).url),
		).toBe(true);
		expect(mockCache.store.has(treeCacheKey(REQ_URL, SLUG, "new", 2, mkUlid(4)).url)).toBe(
			false,
		);
	});

	it("treats a legacy cursor that names no thread as the first page, one cache key", async () => {
		seedThreads(3);
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const first = await get(env, `slug=${SLUG}&sort=new`);
		mockCache.store.clear();
		const probe = await get(env, `slug=${SLUG}&sort=new&before=${mkUlid(999)}`);
		expect(probe.threads.map((t) => t.id)).toEqual(first.threads.map((t) => t.id));
		expect(mockCache.store.size).toBe(1);
		expect(mockCache.store.has(treeCacheKey(REQ_URL, SLUG, "new", 2).url)).toBe(true);
	});

	it("rejects a malformed composite cursor as no cursor", async () => {
		seedThreads(3);
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const first = await get(env, `slug=${SLUG}&sort=new`);
		const bad = await get(env, `slug=${SLUG}&sort=new&before=abc.${mkUlid(2)}`);
		expect(bad.threads.map((t) => t.id)).toEqual(first.threads.map((t) => t.id));
	});

	it("leaves the top cursor format unchanged", async () => {
		seedThreads(4, [3, 1, 2, 0]);
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const page = await get(env, `slug=${SLUG}&sort=top`);
		expect(page.next_cursor).toBe(`2:${mkUlid(3)}`);
	});
});
```

`mockCache` is already a module-scope `let` assigned in `beforeEach`; `mockCache.store` is a `Map`, so `.clear()`, `.size` and `.has()` are available. `setSetting` already exists in the file (line ≈ 192).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/comments-pagination.test.ts`
Expected: the new block fails (cursor emitted as bare ULID; composite cursor decodes to null).

- [ ] **Step 3: Replace the chronological decoder in `api.comments.ts`**

Replace lines 855-871 (`ULID_RE` through `decodeCursor`) with:

```ts
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Chronological-sort cursor: `<created_at_ms>.<ulid>` of the last top-level
 * thread on the current page. The pair is the position; id alone is not,
 * because imported threads carry a fresh ULID over a historical created_at,
 * so id order and time order disagree for them (see listThreadRefsForPost).
 *
 * Shared by `new` and `old`, which differ only in which direction the query
 * reads it. The separator is `.` so it cannot be confused with the `top`
 * cursor's `:`.
 *
 * Re-encoded from the decoded value before use (page cursor and cache key), so
 * `0001003.X` and `1003.X` name one cache entry.
 */
type ChronoCursor = { created_at: number; id: string };
const CHRONO_CURSOR_RE = /^(\d{1,13})\.([0-9A-HJKMNP-TV-Z]{26})$/;
const decodeChronoCursor = (raw: string | null): ChronoCursor | null => {
	if (!raw) return null;
	const m = CHRONO_CURSOR_RE.exec(raw);
	if (!m || m[1] === undefined || m[2] === undefined) return null;
	const created_at = Number.parseInt(m[1], 10);
	if (!Number.isSafeInteger(created_at)) return null;
	return { created_at, id: m[2] };
};
const encodeChronoCursor = (c: ChronoCursor): string => `${c.created_at}.${c.id}`;

/**
 * Pre-2.27.0 chronological cursor: a bare ULID. Widgets loaded before the
 * server upgraded may still hold one. The route resolves it to the pair with
 * one PK lookup (getThreadCreatedAt) before touching the cache.
 */
const decodeLegacyCursor = (raw: string | null): string | null => {
	if (!raw) return null;
	return ULID_RE.test(raw) ? raw : null;
};
```

`decodeTopCursor` and its comment stay as they are.

- [ ] **Step 4: Resolve the cursor in `buildTreePage` before the cache key**

Add `getThreadCreatedAt` to the import from `"../db/queries"` (sorted position, after `getPost`).

Replace lines 1003-1004:

```ts
	const cursor = sort === "top" ? null : decodeCursor(beforeRaw);
	const topCursor = sort === "top" ? decodeTopCursor(beforeRaw) : null;
```

with:

```ts
	const topCursor = sort === "top" ? decodeTopCursor(beforeRaw) : null;
	// Chronological cursor: composite first; else a legacy bare ULID upgraded
	// with one PK lookup. This runs before the cache key is built so the key is
	// always the canonical composite spelling — a legacy spelling must not mint
	// a second entry for the same page. An unresolvable legacy id (deleted
	// thread, wrong slug, random probe) falls through to the first page, which
	// is one fixed key rather than one key per probe.
	let chrono: ChronoCursor | null = null;
	if (sort !== "top" && beforeRaw) {
		chrono = decodeChronoCursor(beforeRaw);
		if (!chrono) {
			const legacyId = decodeLegacyCursor(beforeRaw);
			if (legacyId) {
				const createdAt = await getThreadCreatedAt(env.DB, slug, legacyId);
				if (createdAt !== null) chrono = { created_at: createdAt, id: legacyId };
			}
		}
	}
```

Replace lines 1027-1028:

```ts
	const cursorKey = topCursor ? `${topCursor.score}:${topCursor.id}` : (cursor ?? null);
```

with:

```ts
	const cursorKey = topCursor
		? `${topCursor.score}:${topCursor.id}`
		: chrono
			? encodeChronoCursor(chrono)
			: null;
```

Replace the `cursor:` argument in the `listThreadRefsForPost` call (line ≈ 1055):

```ts
		cursor: topCursor ?? (cursor ? { id: cursor } : null),
```

with:

```ts
		cursor: topCursor ?? chrono,
```

Replace the `next_cursor` computation (line ≈ 1119):

```ts
	const next_cursor = more && lastRef
		? sort === "top"
			? `${lastRef.score}:${lastRef.id}`
			: lastRef.id
		: null;
```

with:

```ts
	const next_cursor = more && lastRef
		? sort === "top"
			? `${lastRef.score}:${lastRef.id}`
			: encodeChronoCursor({ created_at: lastRef.created_at, id: lastRef.id })
		: null;
```

Remove any remaining reference to the old `cursor` variable (grep `cursor ??` and `decodeCursor` in the file; there must be none left).

- [ ] **Step 5: Run the pagination, bootstrap, and widget-boot tests**

Run: `npx vitest run tests/comments-pagination.test.ts tests/bootstrap.test.ts tests/widget-boot.test.ts tests/role-gating.test.ts`
Expected: PASS.

- [ ] **Step 6: Document the cursor format in AGENTS.md**

Near line 388 of `AGENTS.md`, after the sentence ending `what `next_cursor` is a cursor into.`, add:

```
  `next_cursor` is opaque to the widget. For `new`/`old` it is
  `<created_at_ms>.<ulid>` (since 2.27.0; earlier servers emitted a
  bare ULID, which the server still accepts by looking the row up once),
  for `top` it is `<score>:<ulid>`.
```

- [ ] **Step 7: Full local CI, commit, PR**

Run: `npm run lint && npm run typecheck && npm test && npm run manifest:check && npm run build && npm run size`

```bash
git add src/routes/api.comments.ts tests/comments-pagination.test.ts AGENTS.md
git commit -m "fix(comments): emit and accept a created_at.ulid chronological cursor, resolve legacy bare ULIDs once"
git push -u origin fix/n1-chrono-cursor
gh pr create --base main --title "fix: chronological paging cursors on (created_at, id) (N1)" --body "$(cat <<'EOF'
## Summary
- `listThreadRefsForPost` orders and cursors `new`/`old` on `(created_at, id)` and returns `created_at` per ref. Imported threads (fresh ULID, historical created_at) no longer get skipped or repeated.
- Chronological `next_cursor` is now `<created_at_ms>.<ulid>`. A legacy bare-ULID cursor is resolved with one PK lookup before the cache key is built, so the cache key stays canonical; an unresolvable legacy id pages from the start under the single first-page key.
- `top` cursor unchanged. Importer unchanged (user decision).

## Test plan
- [x] real-SQLite query tests with misaligned ids/timestamps, ties, legacy lookup
- [x] route-level tests: format, misaligned paging, legacy equivalence and cache key, unknown legacy id, malformed cursor, top unchanged
- [x] lint, typecheck, test, manifest:check, build, size
EOF
)"
```

---

## Task 6: #58 doc half — widget sends `post_published`; docs match

**Goal:** Both comment-create POST bodies carry `post_published` read from `data-published`, via one DOM-free helper; every doc that describes `data-published` says what the code does.

**Files:**
- Modify: `src/widget/boot.ts` (add `postMetaFromDataset` after `formTokenWanted`)
- Modify: `src/widget/embed.ts:2283-2293` (reply POST body), `:4097-4106` (top-level POST body)
- Create: `tests/widget-post-meta.test.ts`
- Modify: `AGENTS.md:286-288`, `AGENTS.md:1190-1193`, `AGENTS-OPERATE.md:320-340`, `docs/embedding.md:14-22`, `README.md:113-121`
- Read for reference: `src/routes/api.comments.ts:177-190` (`parsePublishedAt` accepts number, numeric string, or ISO string), `:668-677` (`upsertPost` already receives `body.post_published`)

**Acceptance Criteria:**
- [ ] `postMetaFromDataset({ title: "T", url: "U", published: "P" })` returns `{ post_title: "T", post_url: "U", post_published: "P" }`.
- [ ] Missing attributes map to `null`, not `undefined` (the server types accept `string | null`).
- [ ] Both POST bodies spread the helper's result; neither still reads `host.dataset.title` inline.
- [ ] Docs: `data-published` appears in the `docs/embedding.md` and `README.md` snippets; AGENTS.md table row and AGENTS-OPERATE.md auto-close bullet carry the agreed wording (sent by the widget on every create, recorded once by the row-creating request, immutable, repair only via D1 SQL until the admin edit surface ships).

**Verify:** `npx vitest run tests/widget-post-meta.test.ts && npm run typecheck && npm run size && grep -c 'data-published' docs/embedding.md README.md` → tests green, each grep ≥ 1.

**Steps:**

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull --ff-only
git checkout -b feat/58-data-published-widget
```

- [ ] **Step 2: Write the failing test**

Create `tests/widget-post-meta.test.ts`:

```ts
/**
 * The post metadata the widget attaches to every comment create, read off the
 * host element's data-* attributes. `post_published` anchors age-based
 * auto-close on the server; the server records it only on the request that
 * creates the post row, so the widget must send it on every create (it cannot
 * know which one is first).
 */
import { describe, it, expect } from "vitest";
import { postMetaFromDataset } from "../src/widget/boot";

describe("postMetaFromDataset", () => {
	it("passes title, url and published through", () => {
		expect(
			postMetaFromDataset({
				title: "Hello",
				url: "https://example.com/hello/",
				published: "2026-09-11T12:00:00Z",
			}),
		).toEqual({
			post_title: "Hello",
			post_url: "https://example.com/hello/",
			post_published: "2026-09-11T12:00:00Z",
		});
	});

	it("maps missing attributes to null", () => {
		expect(postMetaFromDataset({})).toEqual({
			post_title: null,
			post_url: null,
			post_published: null,
		});
	});

	it("ignores unrelated data-* attributes", () => {
		expect(postMetaFromDataset({ slug: "x", api: "https://c.example", title: "T" })).toEqual({
			post_title: "T",
			post_url: null,
			post_published: null,
		});
	});
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/widget-post-meta.test.ts`
Expected: FAIL, `postMetaFromDataset` not exported.

- [ ] **Step 4: Add the helper to `boot.ts`**

After `formTokenWanted` in `src/widget/boot.ts`:

```ts
/** Post metadata attached to every comment create, from the host's data-*. */
export type PostMeta = {
	post_title: string | null;
	post_url: string | null;
	/** Raw `data-published` (epoch ms or ISO 8601); the server parses it. */
	post_published: string | null;
};

/**
 * Read `data-title`, `data-url` and `data-published` off a host element's
 * dataset. Takes the plain record rather than the element so it stays DOM-free
 * and testable. Missing attributes become null: the server's body type is
 * `string | null` and `upsertPost` treats null as "nothing to record".
 */
export const postMetaFromDataset = (ds: Record<string, string | undefined>): PostMeta => ({
	post_title: ds.title ?? null,
	post_url: ds.url ?? null,
	post_published: ds.published ?? null,
});
```

- [ ] **Step 5: Use it in both POST bodies in `embed.ts`**

Add `postMetaFromDataset` to the import from `./boot`.

Reply body (line ≈ 2283): replace

```ts
					form_ts: formTs,
					post_title: ctx.host.dataset.title ?? null,
					post_url: ctx.host.dataset.url ?? null,
				}),
```

with

```ts
					form_ts: formTs,
					...postMetaFromDataset(ctx.host.dataset),
				}),
```

Top-level body (line ≈ 4097): replace

```ts
				form_ts: formTs,
				post_title: host.dataset.title ?? null,
				post_url: host.dataset.url ?? null,
			}),
```

with

```ts
				form_ts: formTs,
				...postMetaFromDataset(host.dataset),
			}),
```

`DOMStringMap` is assignable to `Record<string, string | undefined>` under `tsconfig.widget.json`; if `typecheck` complains, pass `{ ...host.dataset }`.

- [ ] **Step 6: Run tests, typecheck, size**

Run: `npx vitest run tests/widget-post-meta.test.ts && npm run typecheck && npm run size`
Expected: PASS.

- [ ] **Step 7: Commit the code**

```bash
git add src/widget/boot.ts src/widget/embed.ts tests/widget-post-meta.test.ts
git commit -m "feat(widget): send post_published from data-published on every comment create"
```

- [ ] **Step 8: Docs — AGENTS.md table row (line 288)**

Replace the `data-published` row with:

```
| `data-published` | no   | Article publish time (epoch ms or ISO 8601). The widget sends it as `post_published` on every comment create (top-level and reply); the server records it only on the request that creates the post row and never changes it after that — it arrives on an unauthenticated POST, and an old enough value closes the thread for good, so a later request cannot supply or move it. Anchors age-based auto-close (`AUTO_CLOSE_DAYS`). Omit it and Garrul anchors on first-engagement time, which closes a bit later than intended. If a reaction, page vote or admin action created the row before the first comment, the slug keeps that first-engagement anchor. Repair today is direct D1 SQL on `posts.published_at`; an admin edit surface is a separate backlog item. |
```

- [ ] **Step 9: Docs — AGENTS.md mistakes list (lines 1190-1193)**

The existing bullet already lists `data-published` among the attributes the widget reads. Leave it, and add one bullet directly after it:

```
- Don't expect `data-published` to fix an existing thread's auto-close
  anchor. It is recorded once, by whichever request first created the
  post row. Set it before the first engagement on a page, or repair
  `posts.published_at` with D1 SQL.
```

- [ ] **Step 10: Docs — AGENTS-OPERATE.md auto-close bullet (lines 320-340)**

Replace the sentence:

```
  is the host page's real publish time when the embed supplies `data-published`
  (stored as `posts.published_at`); without it Garrul falls back to first-comment
  time, which is later than real publish, so set `data-published` if you rely on
  `AUTO_CLOSE_DAYS`.
```

with:

```
  is the host page's real publish time when the embed supplies `data-published`
  (the widget sends it as `post_published` on every comment create since
  2.27.0; stored as `posts.published_at`); without it Garrul falls back to
  first-engagement time, which is later than real publish, so set
  `data-published` if you rely on `AUTO_CLOSE_DAYS`.
```

and the sentence

```
  permanently with no repair path short of direct D1 SQL, so a later request is
  not allowed to supply or move it.
```

with

```
  permanently, so a later request is not allowed to supply or move it. The only
  repair path today is direct D1 SQL on `posts.published_at`; an admin edit
  surface for the anchor is a separate backlog item.
```

- [ ] **Step 11: Docs — snippets in `docs/embedding.md` and `README.md`**

In both files, change the snippet:

```html
  data-title="My post title"
  data-url="https://example.com/my-post/"
></div>
```

to:

```html
  data-title="My post title"
  data-url="https://example.com/my-post/"
  data-published="2026-09-11T12:00:00Z"
></div>
```

In `docs/embedding.md`, add one line directly under the snippet:

```
`data-published` is optional. It anchors age-based auto-close (`AUTO_CLOSE_DAYS`) to the article's real publish time; without it the anchor is the first engagement on the thread. It is recorded once, by the request that creates the post row.
```

- [ ] **Step 12: Full local CI, commit docs, PR**

Run: `npm run lint && npm run typecheck && npm test && npm run manifest:check && npm run build && npm run size`

```bash
git add AGENTS.md AGENTS-OPERATE.md docs/embedding.md README.md src/widget/embed.bundled.ts
git commit -m "docs: document data-published as sent by the widget and recorded once"
git push -u origin feat/58-data-published-widget
gh pr create --base main --title "feat: widget sends data-published; docs match the anchor's set-once rule (#58 doc half)" --body "$(cat <<'EOF'
## Summary
- The widget reads `data-published` and sends `post_published` on both comment-create paths via a DOM-free helper (`postMetaFromDataset`). No server change: `upsertPost` already records it on the row-creating request only.
- Docs (AGENTS.md, AGENTS-OPERATE.md, docs/embedding.md, README.md) now state the anchor is sent by the widget on every create, recorded once, immutable, and repairable only by D1 SQL until the admin edit surface (separate backlog item) ships.

## Test plan
- [x] `tests/widget-post-meta.test.ts`
- [x] existing post-title / thread-closure tests unchanged
- [x] lint, typecheck, test, manifest:check, build, size
EOF
)"
```

---

## Task 7: N4 — drafts keyed on the API origin, with legacy adoption

**Goal:** Draft autosave keys include the Worker origin so two Garrul instances on one host page cannot collide; a draft saved under the old key is adopted once into the new key.

**Files:**
- Create: `src/widget/drafts.ts`, `tests/widget-drafts.test.ts`
- Modify: `src/widget/embed.ts:282-330` (remove `DRAFT_PREFIX`, `DRAFT_MAX`, `draftKey`, `clearDraft`, keep `attachDraft` but import the pure pieces), call sites at `:2106`, `:3720`
- Modify: `AGENTS.md` (one bullet in the mistakes list)

**Acceptance Criteria:**
- [ ] `draftKey("https://c.example", "slug", null)` → `garrul:draft:https://c.example:slug`; with parent → `garrul:draft:https://c.example:slug:PARENT`.
- [ ] `legacyDraftKey("slug", null)` → `garrul:draft:slug` (byte-identical to the pre-change key).
- [ ] `adoptLegacyDraft(storage, newKey, legacyKey)` copies the legacy value to the new key and removes the legacy key only when the new key is empty and the legacy key has a value; otherwise it changes nothing.
- [ ] `attachDraft` restores a legacy draft on first mount after upgrade.
- [ ] `npm run size` passes.

**Verify:** `npx vitest run tests/widget-drafts.test.ts && npm run typecheck && npm run size` → green.

**Steps:**

- [ ] **Step 1: Branch and write the failing test**

```bash
git checkout main && git pull --ff-only
git checkout -b fix/n4-draft-key-origin
```

Create `tests/widget-drafts.test.ts`:

```ts
/**
 * Draft keys carry the Worker origin so two Garrul instances embedded on one
 * host page (e.g. staging and production during a migration) cannot restore
 * each other's text. Legacy keys (no origin) are adopted once so an upgrade
 * does not lose a half-typed comment.
 */
import { describe, it, expect } from "vitest";
import { draftKey, legacyDraftKey, adoptLegacyDraft } from "../src/widget/drafts";

const fakeStorage = (init: Record<string, string> = {}) => {
	const m = new Map(Object.entries(init));
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		dump: () => Object.fromEntries(m),
	};
};

describe("draftKey", () => {
	it("includes origin, slug and optional parent", () => {
		expect(draftKey("https://c.example", "post", null)).toBe("garrul:draft:https://c.example:post");
		expect(draftKey("https://c.example", "post", "01H")).toBe(
			"garrul:draft:https://c.example:post:01H",
		);
	});

	it("differs across origins for the same slug", () => {
		expect(draftKey("https://a.example", "post", null)).not.toBe(
			draftKey("https://b.example", "post", null),
		);
	});

	it("legacyDraftKey reproduces the pre-2.27.0 key", () => {
		expect(legacyDraftKey("post", null)).toBe("garrul:draft:post");
		expect(legacyDraftKey("post", "01H")).toBe("garrul:draft:post:01H");
	});
});

describe("adoptLegacyDraft", () => {
	it("moves a legacy draft into the new key when the new key is empty", () => {
		const s = fakeStorage({ "garrul:draft:post": "hello" });
		adoptLegacyDraft(s, "garrul:draft:https://c.example:post", "garrul:draft:post");
		expect(s.dump()).toEqual({ "garrul:draft:https://c.example:post": "hello" });
	});

	it("leaves an existing new-key draft alone", () => {
		const s = fakeStorage({
			"garrul:draft:post": "old",
			"garrul:draft:https://c.example:post": "new",
		});
		adoptLegacyDraft(s, "garrul:draft:https://c.example:post", "garrul:draft:post");
		expect(s.dump()).toEqual({
			"garrul:draft:post": "old",
			"garrul:draft:https://c.example:post": "new",
		});
	});

	it("does nothing when there is no legacy draft", () => {
		const s = fakeStorage();
		adoptLegacyDraft(s, "garrul:draft:https://c.example:post", "garrul:draft:post");
		expect(s.dump()).toEqual({});
	});

	it("swallows storage errors", () => {
		const throwing = {
			getItem: () => {
				throw new Error("disabled");
			},
			setItem: () => {},
			removeItem: () => {},
		};
		expect(() => adoptLegacyDraft(throwing, "a", "b")).not.toThrow();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/widget-drafts.test.ts`
Expected: FAIL, module `../src/widget/drafts` not found.

- [ ] **Step 3: Create `src/widget/drafts.ts`**

```ts
/**
 * Draft autosave keys and the one-time legacy adoption.
 *
 * DOM-free on purpose (tsconfig.widget.json, plain node tests). embed.ts owns
 * the textarea wiring; this module owns what the key looks like and how a
 * pre-2.27.0 draft (no origin in the key) is carried over.
 *
 * Why the origin: localStorage is per host-page origin, so two Garrul
 * instances embedded on one page (different `data-api`) shared a key for the
 * same slug and restored each other's text. The API origin is the identity of
 * the instance the draft belongs to.
 */

const DRAFT_PREFIX = "garrul:draft:";

/** Cap on stored bytes; the server rejects oversized bodies anyway. */
export const DRAFT_MAX = 10_000;

/** The subset of Storage this module touches; lets tests pass a plain object. */
export type DraftStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};

export const draftKey = (origin: string, slug: string, parentId: string | null): string =>
	`${DRAFT_PREFIX}${origin}:${slug}${parentId ? `:${parentId}` : ""}`;

/** The pre-2.27.0 key, kept only so adoptLegacyDraft can find old drafts. */
export const legacyDraftKey = (slug: string, parentId: string | null): string =>
	`${DRAFT_PREFIX}${slug}${parentId ? `:${parentId}` : ""}`;

/**
 * Copy a draft saved under the legacy key into the new key, then remove the
 * legacy entry — only when the new key is empty and the legacy key has text.
 * Any storage error (Safari private mode, disabled storage) is swallowed:
 * losing an old draft is acceptable, breaking the composer is not.
 */
export const adoptLegacyDraft = (
	storage: DraftStorage,
	newKey: string,
	legacyKey: string,
): void => {
	try {
		if (storage.getItem(newKey)) return;
		const old = storage.getItem(legacyKey);
		if (!old) return;
		storage.setItem(newKey, old.slice(0, DRAFT_MAX));
		storage.removeItem(legacyKey);
	} catch {
		// Storage unavailable — nothing to adopt.
	}
};
```

- [ ] **Step 4: Rewire `embed.ts`**

Add the import (sorted among the `./` imports):

```ts
import { DRAFT_MAX, adoptLegacyDraft, draftKey, legacyDraftKey } from "./drafts";
```

Delete from `embed.ts` the local `DRAFT_PREFIX`, `DRAFT_MAX` (and its comment), and `draftKey` (lines 282-288). Keep `clearDraft` and `attachDraft`. Change `attachDraft`'s signature so it adopts the legacy draft before restoring:

```ts
const attachDraft = (ta: HTMLTextAreaElement, key: string, legacyKey: string): string => {
	adoptLegacyDraft(localStorage, key, legacyKey);
	try {
		const saved = localStorage.getItem(key);
```

(The rest of the function is unchanged; `DRAFT_MAX` now comes from the import.) `adoptLegacyDraft` already guards `localStorage` throwing on access inside its try; if `localStorage` itself is not defined the surrounding mount already fails earlier, so no extra guard is needed.

Compute the origin once near where `apiBase` is resolved (line ≈ 2965):

```ts
	const apiBase = host.dataset.api ?? SCRIPT_ORIGIN ?? window.location.origin;
	const apiOrigin = new URL(apiBase).origin;
```

`WidgetCtx` (line 663) gains `apiOrigin: string;` after `apiBase`, and the `ctx` construction (line ≈ 3670) sets `apiOrigin,`.

Update the four draft call sites:

```ts
// reply form (≈ 2106)
const dkey = attachDraft(
	ta,
	draftKey(ctx.apiOrigin, ctx.slug, parent.id),
	legacyDraftKey(ctx.slug, parent.id),
);
// mount composer (≈ 3720)
if (composer)
	attachDraft(composer, draftKey(apiOrigin, slug, null), legacyDraftKey(slug, null));
// top-level submit success (≈ 4126)
clearDraft(draftKey(apiOrigin, slug, null));
```

The two reply-path `clearDraft(dkey)` calls (≈ 2214, ≈ 2310) are unchanged. If `apiOrigin` is not in scope at line ≈ 4126 (the top-level submit handler), read it from the same closure that holds `apiBase` there; the handler already uses `apiBase`, so `new URL(apiBase).origin` at that site is acceptable.

- [ ] **Step 5: Run tests, typecheck, size**

Run: `npx vitest run tests/widget-drafts.test.ts && npm run typecheck && npm run size`
Expected: PASS.

- [ ] **Step 6: AGENTS.md mistakes list**

Add a bullet after the `data-api` `https://` bullet (line ≈ 1194):

```
- Don't assume comment drafts survive a `data-api` change. Draft
  autosave keys are `garrul:draft:<api origin>:<slug>[:<parent>]` (since
  2.27.0), so a draft belongs to one Worker origin. Pre-2.27.0 drafts
  (`garrul:draft:<slug>`) are adopted once on the next mount.
```

- [ ] **Step 7: Full local CI, commit, PR**

Run: `npm run lint && npm run typecheck && npm test && npm run manifest:check && npm run build && npm run size`

```bash
git add src/widget/drafts.ts src/widget/embed.ts src/widget/embed.bundled.ts tests/widget-drafts.test.ts AGENTS.md
git commit -m "fix(widget): key comment drafts on the API origin and adopt legacy drafts once"
git push -u origin fix/n4-draft-key-origin
gh pr create --base main --title "fix: draft autosave keys include the Worker origin (N4)" --body "$(cat <<'EOF'
## Summary
- New pure module `src/widget/drafts.ts`: `draftKey(origin, slug, parent)`, `legacyDraftKey`, `adoptLegacyDraft`.
- Two Garrul instances on one host page no longer share a draft for the same slug. A pre-upgrade draft is moved into the new key on first mount.

## Test plan
- [x] `tests/widget-drafts.test.ts` (keys, cross-origin distinctness, adoption rules, storage errors)
- [x] lint, typecheck, test, manifest:check, build, size
EOF
)"
```

---

## Task 8: O1 — engagement queries scoped to the page's comment ids

**Goal:** `buildTreePage` loads reactions, the viewer's reactions, and the viewer's votes only for the comments on the page, in `IN (...)` batches of 90, and the three whole-slug queries are removed.

**Files:**
- Modify: `src/db/queries.ts:971-995` (`listReactionsForPost` → `listReactionsForComments`), `:1026-1045` (`listUserReactionsOnPost` → `listUserReactionsOnComments`), `:3804-3822` (`getUserVotesOnPost` → `getUserVotesOnComments`); add an `IN_BATCH`/`chunk` helper near the top of the file
- Modify: `src/routes/api.comments.ts:24-40` (imports), `:1078-1095` (call sites)
- Modify: `tests/comments-pagination.test.ts` (new describe), `AGENTS-OPERATE.md` (one sentence)

**Acceptance Criteria:**
- [ ] Page 1 of a post carries only reactions/votes belonging to page-1 comments; page-2 reactions are not fetched (the recorded reactions query binds only page-1 ids and its recorded row count equals the number of reactions on page-1 comments).
- [ ] Response shape (`reactions[]` per node with `kind`, `count`, `mine`; `my_vote`) is unchanged.
- [ ] Empty id list returns empty results with no query.
- [ ] A 200-id page produces 3 batches (90, 90, 20) for each of the three queries.
- [ ] `grep -n 'ReactionsForPost\|UserReactionsOnPost\|VotesOnPost' src tests` returns nothing.

**Verify:** `npx vitest run tests/comments-pagination.test.ts tests/bootstrap.test.ts` → green; the grep above is empty.

**Steps:**

- [ ] **Step 1: Branch and write the failing route-level test**

```bash
git checkout main && git pull --ff-only
git checkout -b perf/o1-engagement-page-scope
```

In `tests/comments-pagination.test.ts` add a seeding helper next to `seedReplies` (votes need a session, and `mkEnv` has none, so only reactions are seeded at the route level; the batching test in Step 2 exercises the vote query directly):

```ts
const seedReaction = (commentId: string, userId: string, kind = "heart") => {
	sqlite
		.prepare("INSERT INTO reactions (comment_id, user_id, kind, created_at) VALUES (?, ?, ?, 1)")
		.run(commentId, userId, kind);
};
```

Extend `ListResp` so the assertions can type the fields:

```ts
type ListResp = {
	threads: {
		id: string;
		score_up: number;
		score_down: number;
		reactions: { kind: string; count: number; mine: boolean }[];
		my_vote: -1 | 0 | 1;
		replies: unknown[];
	}[];
	next_cursor: string | null;
	sort: string;
};
```

Add the describe block:

```ts
describe("engagement queries are scoped to the page", () => {
	const reactionsQueries = () =>
		queries.filter((q) => /FROM reactions r/.test(q.sql) && /IN \(/.test(q.sql));

	it("loads reactions only for the comments on the page", async () => {
		// Page size comes from the `comments_per_page` setting (there is no
		// query param). With 2 per page, new-sort page 1 = threads 4,3; page 2 = 2,1.
		seedThreads(4);
		seedReaction(mkUlid(4), USER, "heart");
		seedReaction(mkUlid(1), USER, "heart");
		seedReaction(mkUlid(2), USER, "laugh");
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		queries.length = 0;
		const page = await get(env, `slug=${SLUG}&sort=new`);

		expect(page.threads.map((t) => t.id)).toEqual([mkUlid(4), mkUlid(3)]);
		expect(page.threads[0]?.reactions).toEqual([{ kind: "heart", count: 1, mine: false }]);
		expect(page.threads[1]?.reactions).toEqual([]);

		const rq = reactionsQueries();
		expect(rq.length).toBe(1);
		// Binds are exactly the page's comment ids; nothing from page 2.
		expect([...rq[0]!.binds].sort()).toEqual([mkUlid(3), mkUlid(4)].sort());
		// `Recorded.rows` is the row COUNT the stub saw. Only thread 4's heart
		// matches the page ids, so exactly one row comes back.
		expect(rq[0]!.rows).toBe(1);
	});

	it("includes replies on the page in the id set", async () => {
		seedThreads(1);
		seedReplies(1, 1); // one reply under thread 1, id mkUlid(100_000)
		const replyId = mkUlid(100_000);
		seedReaction(replyId, USER, "heart");
		const env = mkEnv();
		queries.length = 0;
		await get(env, `slug=${SLUG}&sort=new`);
		const rq = reactionsQueries();
		expect(rq.length).toBe(1);
		expect(rq[0]!.binds).toContain(replyId);
	});

	it("issues no engagement query for an empty page", async () => {
		const env = mkEnv();
		queries.length = 0;
		const page = await get(env, `slug=${SLUG}&sort=new`);
		expect(page.threads).toEqual([]);
		expect(reactionsQueries().length).toBe(0);
	});
});
```

Confirm `seedReplies(1, 1)` mints the reply id as `mkUlid(100_000)` by reading its body (`let n = 100_000;` then `mkUlid(n++)`); adjust `replyId` to match. `Recorded` is `{ sql: string; binds: unknown[]; rows: number }`: `rows` is a count, not the row array, so never iterate it. Sessions are `null` in `mkEnv`, so the `mine`/`my_vote` queries do not run here; the batching helper test in Step 2 covers those two functions.

- [ ] **Step 2: Add a unit test for the batching with a recording D1 stub**

Append to the same file (or a new `tests/queries-engagement-batch.test.ts` if you prefer a smaller file; either is fine):

```ts
describe("engagement query batching", () => {
	const ids = Array.from({ length: 200 }, (_, i) => mkUlid(i + 1));

	it("splits 200 ids into batches of 90, 90, 20 for all three queries", async () => {
		seedThreads(0);
		const env = mkEnv();
		queries.length = 0;
		const db = env.DB;
		await listReactionsForComments(db, ids);
		await listUserReactionsOnComments(db, ids, USER);
		await getUserVotesOnComments(db, ids, USER);
		const sizes = queries.map((q) => q.binds.length);
		// reactions: ids only; user reactions and votes: ids + user_id
		expect(sizes).toEqual([90, 90, 20, 91, 91, 21, 91, 91, 21]);
	});

	it("returns empty results and runs no query for an empty id list", async () => {
		const env = mkEnv();
		queries.length = 0;
		expect(await listReactionsForComments(env.DB, [])).toEqual([]);
		expect(await listUserReactionsOnComments(env.DB, [], USER)).toEqual(new Set());
		expect(await getUserVotesOnComments(env.DB, [], USER)).toEqual(new Map());
		expect(queries.length).toBe(0);
	});
});
```

Import `listReactionsForComments`, `listUserReactionsOnComments`, `getUserVotesOnComments` from `../src/db/queries` at the top of the file.

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/comments-pagination.test.ts`
Expected: FAIL (functions not exported; reactions query has no `IN (`).

- [ ] **Step 4: Rewrite the three queries in `queries.ts`**

Add near the top of `src/db/queries.ts` (after the imports):

```ts
/**
 * Max ids per `IN (...)` list. D1 caps bound parameters at 100; 90 leaves room
 * for the other binds a statement carries (user_id etc.). Same figure as
 * AUTHOR_BATCH in api.comments.ts.
 */
const IN_BATCH = 90;

const chunk = <T>(xs: readonly T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
	return out;
};
```

Replace `listReactionsForPost` (lines 971-995) with:

```ts
export type ReactionSummary = {
	comment_id: string;
	kind: string;
	count: number;
};

/**
 * Aggregate reactions for a set of comments: (comment_id, kind, count).
 * Caller pivots to per-comment buckets. Scoped to the ids on the page rather
 * than the whole post so a 5,000-comment thread does not pay for every
 * reaction on every page request.
 */
export const listReactionsForComments = async (
	db: D1Database,
	comment_ids: readonly string[],
): Promise<ReactionSummary[]> => {
	const out: ReactionSummary[] = [];
	for (const batch of chunk(comment_ids, IN_BATCH)) {
		const placeholders = batch.map(() => "?").join(",");
		const result = await db
			.prepare(
				`SELECT r.comment_id, r.kind, COUNT(*) AS count
				 FROM reactions r
				 WHERE r.comment_id IN (${placeholders})
				 GROUP BY r.comment_id, r.kind`,
			)
			.bind(...batch)
			.all<ReactionSummary>();
		out.push(...(result.results ?? []));
	}
	return out;
};
```

Replace `listUserReactionsOnPost` (lines 1026-1045) with:

```ts
/** `comment_id|kind` pairs the viewer has reacted with, over a set of comments. */
export const listUserReactionsOnComments = async (
	db: D1Database,
	comment_ids: readonly string[],
	user_id: string,
): Promise<Set<string>> => {
	const out = new Set<string>();
	for (const batch of chunk(comment_ids, IN_BATCH)) {
		const placeholders = batch.map(() => "?").join(",");
		const result = await db
			.prepare(
				`SELECT r.comment_id, r.kind
				 FROM reactions r
				 WHERE r.comment_id IN (${placeholders}) AND r.user_id = ?`,
			)
			.bind(...batch, user_id)
			.all<{ comment_id: string; kind: string }>();
		for (const row of result.results ?? []) out.add(`${row.comment_id}|${row.kind}`);
	}
	return out;
};
```

Replace `getUserVotesOnPost` (lines 3804-3822) with:

```ts
/** The viewer's vote per comment, over a set of comments. */
export const getUserVotesOnComments = async (
	db: D1Database,
	comment_ids: readonly string[],
	user_id: string,
): Promise<Map<string, -1 | 1>> => {
	const out = new Map<string, -1 | 1>();
	for (const batch of chunk(comment_ids, IN_BATCH)) {
		const placeholders = batch.map(() => "?").join(",");
		const result = await db
			.prepare(
				`SELECT v.comment_id, v.value
				   FROM votes v
				  WHERE v.comment_id IN (${placeholders}) AND v.user_id = ?`,
			)
			.bind(...batch, user_id)
			.all<{ comment_id: string; value: number }>();
		for (const r of result.results ?? []) {
			if (r.value === 1 || r.value === -1) out.set(r.comment_id, r.value);
		}
	}
	return out;
};
```

The `JOIN comments c ... WHERE c.post_slug = ?` is dropped on purpose: the ids already came from a query filtered on the slug and the visibility predicate, so the join added nothing but a scan. Update the doc comment of the type above if it refers to "every comment on a post".

- [ ] **Step 5: Update the call sites in `buildTreePage`**

In the import block of `src/routes/api.comments.ts` replace `getUserVotesOnPost` → `getUserVotesOnComments`, `listReactionsForPost` → `listReactionsForComments`, `listUserReactionsOnPost` → `listUserReactionsOnComments` (keep the list sorted).

Replace lines 1078-1095:

```ts
	const reactionRows = await listReactionsForPost(env.DB, slug);
	const mineSet = session
		? await listUserReactionsOnPost(env.DB, slug, session.user_id)
		: new Set<string>();
	...
	const myVotes = session
		? await getUserVotesOnPost(env.DB, slug, session.user_id)
		: new Map<string, -1 | 1>();
```

with:

```ts
	// Engagement is loaded for the comments on this page only. `rows` is every
	// comment listCommentsForThreads returned for the page's threads (top-level
	// and replies), so ids here are exactly what buildTree will render.
	const pageIds = rows.map((r) => r.id);
	const reactionRows = await listReactionsForComments(env.DB, pageIds);
	const mineSet = session
		? await listUserReactionsOnComments(env.DB, pageIds, session.user_id)
		: new Set<string>();
	const reactionsById = new Map<string, ReactionCount[]>();
	for (const r of reactionRows) {
		const list = reactionsById.get(r.comment_id) ?? [];
		list.push({
			kind: r.kind,
			count: r.count,
			mine: mineSet.has(`${r.comment_id}|${r.kind}`),
		});
		reactionsById.set(r.comment_id, list);
	}
	const myVotes = session
		? await getUserVotesOnComments(env.DB, pageIds, session.user_id)
		: new Map<string, -1 | 1>();
```

Keep the existing `reactionsById` pivot loop exactly as it is if its body differs cosmetically from the above; only the three function calls and the `pageIds` line change.

- [ ] **Step 6: Run the tests and the leftover-name grep**

Run: `npx vitest run tests/comments-pagination.test.ts tests/bootstrap.test.ts && grep -rn 'ReactionsForPost\|UserReactionsOnPost\|VotesOnPost' src tests; echo "grep exit $?"`
Expected: tests PASS; grep prints nothing and exits 1.

- [ ] **Step 7: AGENTS-OPERATE.md**

In the request-count / performance area near line 1609 (the bullet describing `GET /api/v1/bootstrap`), append one sentence to that bullet:

```
  Reactions, the viewer's reactions and the viewer's votes are loaded for
  the comments on the returned page only (batched `IN` lists of 90), not
  for the whole post, so page cost does not grow with thread size.
```

- [ ] **Step 8: Full local CI, commit, PR**

Run: `npm run lint && npm run typecheck && npm test && npm run manifest:check && npm run build && npm run size`

```bash
git add src/db/queries.ts src/routes/api.comments.ts tests/comments-pagination.test.ts AGENTS-OPERATE.md
git commit -m "perf(comments): load reactions and votes for the page's comments only"
git push -u origin perf/o1-engagement-page-scope
gh pr create --base main --title "perf: scope engagement queries to the comments on the page (O1)" --body "$(cat <<'EOF'
## Summary
- `listReactionsForComments`, `listUserReactionsOnComments`, `getUserVotesOnComments` replace the three whole-slug queries; each batches `IN (...)` lists of 90 ids.
- `buildTreePage` passes the ids of the comments it will render. Response shape unchanged.

## Test plan
- [x] route-level real-SQLite test: page 1 carries only page-1 reactions, the recorded query binds only page-1 ids, replies included, empty page issues no query
- [x] batching unit test (200 ids → 90/90/20)
- [x] lint, typecheck, test, manifest:check, build, size
EOF
)"
```

---

## Task 9: Release 2.27.0

**Goal:** After all five PRs merge in order, cut `v2.27.0` with an operator-focused body and title.

**Files:**
- Modify: `package.json` (`"version": "2.27.0"`), `package-lock.json`, `release-manifest.json` (via `npm run manifest:build`)

**Acceptance Criteria:**
- [ ] `npm run manifest:check` passes on the release commit.
- [ ] Tag `v2.27.0` exists, annotated, message mirrors the body.
- [ ] GitHub release body names: `form_token_enabled`, the chronological cursor format change and legacy acceptance, `data-published` now sent by the widget, draft keys per origin, engagement queries scoped per page. Title format `v2.27.0 — <operator-visible change>`.

**Verify:** `gh release view v2.27.0` shows the rewritten title and body; `npm run manifest:check` → OK.

**Steps:**

- [ ] **Step 1: Confirm merge order and a clean main**

```bash
git checkout main && git pull --ff-only
git log --oneline -12
```

Expected: merges for O2, N1, #58, N4, O1 are all present.

- [ ] **Step 2: Bump and rebuild the manifest**

```bash
git checkout -b release/2.27.0
npm version 2.27.0 --no-git-tag-version
npm run manifest:build
npm run manifest:check
git add package.json package-lock.json release-manifest.json
git commit -m "chore(release): 2.27.0"
git push -u origin release/2.27.0
gh pr create --base main --title "chore(release): 2.27.0" --body "Version bump and manifest for 2.27.0. Notes are in the tag and GitHub release."
```

If `release-manifest.json` has free-text fields (`breakingChanges`, descriptions) that need a line for the cursor format change, add: "Chronological `next_cursor` is now `<created_at_ms>.<ulid>`; servers accept the old bare-ULID form."

- [ ] **Step 3: After the release PR merges, tag and publish**

```bash
git checkout main && git pull --ff-only
git tag -a v2.27.0 -m "$(cat <<'EOF'
v2.27.0 — one-request mounts when timing is off, and correct chronological paging for imports

feat:
- /api/v1/config carries form_token_enabled; the widget skips /comments/form-token when it is false, so a default install mounts in one Worker request.
- The widget sends data-published as post_published on every comment create; the server still records it once, on the request that creates the post row.

fix:
- Chronological paging (new/old) orders and cursors on (created_at, id). Imported threads are no longer skipped or repeated. next_cursor is now <created_at_ms>.<ulid>; the old bare-ULID cursor is still accepted.
- Widget draft autosave keys include the Worker origin; two instances on one page no longer share drafts. Old drafts are adopted once.

perf:
- Reactions and votes are loaded for the comments on the page only, not the whole post.
EOF
)"
git push origin v2.27.0
```

Wait for `release.yml` to create the release, then:

```bash
gh release edit v2.27.0 --title "v2.27.0 — one-request mounts when timing is off, and correct chronological paging for imports" --notes "$(cat <<'EOF'
**feat**
- `GET /api/v1/config` (and bootstrap's `config`) carries `form_token_enabled`. The widget skips `/api/v1/comments/form-token` when it is `false`, so a default install (no `SPAM_FORM_TS_SECRET`, or `SPAM_HONEYPOT_MIN_MS=0`) mounts in **one** Worker request.
- The widget now sends `data-published` as `post_published` on every comment create. The server records it once, on the request that creates the post row; set the attribute before the first engagement on a page.

**fix**
- Chronological paging (`new`/`old`) orders and cursors on `(created_at, id)`. Imported threads (fresh ULID, historical `created_at`) are no longer skipped or repeated across pages. `next_cursor` is now `<created_at_ms>.<ulid>`; the pre-2.27.0 bare-ULID cursor is still accepted.
- Widget draft autosave keys include the Worker origin (`garrul:draft:<origin>:<slug>`), so two Garrul instances embedded on one page no longer restore each other's text. Existing drafts are adopted once.

**perf**
- Reactions and votes are loaded for the comments on the returned page only (batched `IN` lists), not for the whole post.

No new env vars or secrets. No migration.
EOF
)"
```

- [ ] **Step 4: Journal and backlog**

```bash
/home/kingpin/.claude/scripts/claude-journal.sh --block "Released: Garrul v2.27.0" <<'EOF'
Items: O2 form_token_enabled, N1 chrono cursor, 58 doc half (data-published wired), N4 draft keys per origin, O1 page-scoped engagement
Release: https://github.com/KingPin/Garrul/releases/tag/v2.27.0
EOF
```

Then mark O2, N1, 58 (doc half), N4, O1 done in the Obsidian `Garrul backlog` note (item 58's code half stays open).

---

## Self-review notes

- **Spec coverage.** O2 → Tasks 1-3. N1 (query + cursor only) → Tasks 4-5; importer untouched. #58 doc half (wire widget + docs) → Task 6. N4 → Task 7. O1 → Task 8. Release → Task 9. Plan committed in the O2 PR → Task 3 Step 7.
- **Type consistency.** `ThreadRef.created_at: number` (Task 4) is what Task 5's `encodeChronoCursor({ created_at: lastRef.created_at, id })` reads. `listThreadRefsForPost`'s `cursor` type `{ score?: number; created_at?: number; id: string }` (Task 4) accepts Task 5's `topCursor ?? chrono` (both `{score,id}` and `{created_at,id}`). `formTokenWanted`, `postMetaFromDataset`, `PostMeta` live in `boot.ts` (Tasks 2, 6). `draftKey(origin, slug, parentId)`, `legacyDraftKey(slug, parentId)`, `adoptLegacyDraft(storage, newKey, legacyKey)`, `DRAFT_MAX`, `DraftStorage` live in `drafts.ts` (Task 7). `listReactionsForComments(db, ids)`, `listUserReactionsOnComments(db, ids, user_id)`, `getUserVotesOnComments(db, ids, user_id)`, `getThreadCreatedAt(db, slug, id)` are the only new query exports (Tasks 4, 8).
- **Known line-number drift.** Line numbers are from `main` at 9a7079a. Tasks 5 and 8 both edit `src/routes/api.comments.ts`; whichever merges second will find shifted lines. Each edit is anchored on quoted code, not on the number.
- **Legacy-cursor read cost.** One primary-key `SELECT created_at` per request that still carries a bare-ULID cursor, bounded to zero once cached widgets reload. An unresolvable id collapses to the first-page key, so probing cannot mint cache entries.
