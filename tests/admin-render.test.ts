/**
 * Render-correctness tests for the new admin pages. These are pure
 * string-template functions, so they fit the existing node-pool harness.
 *
 * D1-touching paths (query wrappers, rerender batch, seed-demo, bulk
 * endpoint) are not exercised here — they require the workers pool +
 * Miniflare scaffolding, which is a follow-up. The renderers are what
 * users see, so HTML-escape regressions here are user-visible.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	QUEUE_SHORTCUTS,
	renderQueue,
	rowActionToasts,
	type QueueFilters,
} from "../src/admin-ui/pages/queue";
import { renderCommentDetail } from "../src/admin-ui/pages/comment-detail";
import { escapeHtml } from "../src/admin-ui/escape";
import { renderAudit, type AuditFilters } from "../src/admin-ui/pages/audit";
import {
	renderSubscriptions,
	type SubscriptionsFilters,
} from "../src/admin-ui/pages/subscriptions";
import { renderOperator } from "../src/admin-ui/pages/operator";
import type { RetentionStats } from "../src/db/ip-retention";
import type { AuditRetentionStats } from "../src/db/audit-retention";
import { renderSettings } from "../src/admin-ui/pages/settings";
import { MAX_IMPORT_BYTES } from "../src/lib/import/core";
import { renderDashboard } from "../src/admin-ui/pages/dashboard";
import { layout, renderUpdateBanner } from "../src/admin-ui/layout";
import {
	FLAG_KEYS,
	NUMBER_KEYS,
	type ResolvedFlags,
	type ResolvedNumbers,
	type ResolvedStrings,
	STRING_KEYS,
	type ResolvedTexts,
	TEXT_KEYS,
	stringDefault,
	stringOptions,
} from "../src/lib/settings";
import { ADMIN_ACTIONS } from "../src/db/queries";
import type {
	AdminComment,
	AdminStats,
	AuditRowWithAdmin,
	Subscription,
	User,
} from "../src/db/queries";
import type { Bindings } from "../src/index";

const makeComment = (over: Partial<AdminComment> = {}): AdminComment => ({
	id: "01HXX000000000000000000001",
	post_slug: "hello-world",
	parent_id: null,
	user_id: "01HXY000000000000000000001",
	body_md: "hello",
	body_html: "<p>hello</p>",
	renderer_version: 1,
	status: "pending",
	edited_at: null,
	deleted_at: null,
	ip_hash: null,
	user_agent: null,
	created_at: 1_700_000_000_000,
	deleted_by: null,
	depth: 1,
	score_up: 0,
	score_down: 0,
	author_name: "Alice",
	author_email: null,
	author_avatar_url: null,
	author_provider: "github",
	author_is_admin: false,
	author_is_banned: false,
	host: "blog.example.com",
	post_url: null,
	post_title: null,
	...over,
});

const emptyQueueFilters: QueueFilters = {
	status: "pending",
	q: "",
	post_slug: "",
	user_id: "",
	from: "",
	to: "",
	host: "",
	reported: false,
};

describe("renderQueue", () => {
	it("renders the author cell with provider and name", () => {
		const html = renderQueue([makeComment()], emptyQueueFilters, null);
		expect(html).toContain("Alice");
		expect(html).toContain("github");
		expect(html).toContain("/admin/users/01HXY000000000000000000001");
	});

	it("escapes a malicious author name", () => {
		const html = renderQueue(
			[makeComment({ author_name: "<img src=x onerror=alert(1)>" })],
			emptyQueueFilters,
			null,
		);
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});

	// Action buttons we care about live inside a per-row <td class="actions">.
	// The bulk-bar at the bottom also has Approve/Spam/Delete buttons, so any
	// status-conditional assertion must scope to the row's actions cell.
	const rowActionsCell = (html: string): string => {
		const m = html.match(/<td class="actions">([\s\S]*?)<\/td>/);
		return m ? m[1] ?? "" : "";
	};

	it("shows Approve+Spam+Delete for a pending comment", () => {
		const cell = rowActionsCell(
			renderQueue([makeComment({ status: "pending" })], emptyQueueFilters, null),
		);
		expect(cell).toContain(">Approve<");
		expect(cell).toContain(">Spam<");
		expect(cell).toContain(">Delete<");
	});

	it("shows Restore+Delete (no Spam) for a spam comment", () => {
		const cell = rowActionsCell(
			renderQueue(
				[makeComment({ status: "spam" })],
				{ ...emptyQueueFilters, status: "spam" },
				null,
			),
		);
		expect(cell).toContain(">Restore<");
		expect(cell).toContain(">Delete<");
		expect(cell).not.toContain(">Spam<");
	});

	it("shows only Restore for a deleted comment", () => {
		const cell = rowActionsCell(
			renderQueue(
				[makeComment({ status: "deleted" })],
				{ ...emptyQueueFilters, status: "deleted" },
				null,
			),
		);
		expect(cell).toContain(">Restore<");
		expect(cell).not.toContain(">Delete<");
		expect(cell).not.toContain(">Spam<");
	});

	it("preserves active filters across status tab links", () => {
		const html = renderQueue(
			[],
			{ ...emptyQueueFilters, q: "foo", post_slug: "blog/post" },
			null,
		);
		expect(html).toContain("q=foo");
		expect(html).toContain("post_slug=blog");
	});

	it("keeps the reported view on the filter form and clear link", () => {
		const html = renderQueue(
			[],
			{ ...emptyQueueFilters, reported: true, q: "foo" },
			null,
		);
		// The form re-submits the reported dimension, not status, so filtering
		// within the reported view stays in it.
		expect(html).toContain('name="reported" value="1"');
		expect(html).not.toContain('name="status"');
		// Clear returns to the reported tab rather than dropping to status view.
		expect(html).toContain('href="/admin/queue?reported=1"');
	});

	it("encodes the keyset cursor into the Next link", () => {
		const html = renderQueue(
			[makeComment()],
			emptyQueueFilters,
			"1700000000000|01HXX0",
		);
		expect(html).toContain("before=1700000000000%7C01HXX0");
	});

	it("emits the toast + bulk-done dispatch on action success", () => {
		const html = renderQueue([makeComment()], emptyQueueFilters, null);
		expect(html).toContain("$dispatch('toast'");
		expect(html).toContain("$dispatch('bulk-done'");
	});

	// Regression: the bulk x-data block previously interpolated
	// `JSON.stringify(allIds)` raw, so the first `"` of the JSON array
	// closed the x-data="..." attribute and the rest of the JS body
	// leaked into the page as visible text. The fix HTML-escapes the
	// JSON (matching the `jsLiteral` helper used elsewhere in the file).
	it("HTML-escapes the allIds JSON so it cannot break out of x-data", () => {
		const html = renderQueue([makeComment()], emptyQueueFilters, null);
		expect(html).not.toMatch(/allIds: \["/);
		expect(html).toContain("allIds: [&quot;");
	});

	it("renders the host dropdown populated with the supplied hosts", () => {
		const html = renderQueue(
			[makeComment()],
			emptyQueueFilters,
			null,
			new Map(),
			["blog.example.com", "shop.example.com", "(no url)"],
		);
		expect(html).toContain('<select name="host"');
		expect(html).toContain('value="blog.example.com"');
		expect(html).toContain('value="shop.example.com"');
		expect(html).toContain('value="(no url)"');
		expect(html).toContain('<option value="" selected>all domains</option>');
	});

	it("preserves the host filter across status tab links", () => {
		const html = renderQueue(
			[],
			{ ...emptyQueueFilters, host: "blog.example.com" },
			null,
		);
		expect(html).toContain("host=blog.example.com");
	});

	it("shows the host on the comment row", () => {
		const html = renderQueue(
			[makeComment({ host: "shop.example.com" })],
			emptyQueueFilters,
			null,
		);
		expect(html).toContain("shop.example.com");
	});

	it("escapes a hostile host string in the row cell", () => {
		const html = renderQueue(
			[makeComment({ host: `<script>alert(1)</script>` })],
			emptyQueueFilters,
			null,
		);
		expect(html).not.toContain("<script>alert");
		expect(html).toContain("&lt;script&gt;");
	});

	it("links the META cell to the original page in a new tab", () => {
		const html = renderQueue(
			[makeComment({ post_url: "https://blog.example.com/hello" })],
			emptyQueueFilters,
			null,
		);
		expect(html).toContain('href="https://blog.example.com/hello"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer nofollow"');
	});

	it("refuses to emit a non-http(s) post_url as a link", () => {
		const html = renderQueue(
			[makeComment({ post_url: "javascript:alert(1)" })],
			emptyQueueFilters,
			null,
		);
		expect(html).not.toContain("href=\"javascript:");
		// Still renders the slug/host as plain text.
		expect(html).toContain("hello-world");
	});

	it("shows the post title when present", () => {
		const html = renderQueue(
			[makeComment({ post_title: "My Great Post" })],
			emptyQueueFilters,
			null,
		);
		expect(html).toContain("My Great Post");
	});

	it("renders a click-to-copy comment ID", () => {
		const html = renderQueue([makeComment()], emptyQueueFilters, null);
		expect(html).toContain('class="cid muted"');
		expect(html).toContain("navigator.clipboard.writeText");
	});

	it("renders the latest-audit footer strip when present", () => {
		const audit: AuditRowWithAdmin = {
			id: "audit1",
			admin_id: "admin1",
			admin_name: "Carla",
			action: "approve",
			target_kind: "comment",
			target_id: "01HXX000000000000000000001",
			reason: null,
			meta: null,
			created_at: Date.now() - 60_000,
		};
		const map = new Map<string, AuditRowWithAdmin>();
		map.set("01HXX000000000000000000001", audit);
		const html = renderQueue([makeComment()], emptyQueueFilters, null, map);
		expect(html).toContain("audit-strip");
		expect(html).toContain("approve by Carla");
	});
});

describe("renderAudit", () => {
	const filters: AuditFilters = {
		admin_id: "",
		action: "",
		target_kind: "",
		target_id: "",
		from: "",
		to: "",
		host: "",
	};
	// The real list, not a copy: a hand-maintained duplicate had already
	// drifted to 15 of the 34 actions without anything noticing.
	const adminActions = ADMIN_ACTIONS;

	it("populates the action dropdown from the supplied enum", () => {
		const html = renderAudit([], filters, null, adminActions);
		expect(html).toContain('value="bulk.approve"');
		expect(html).toContain('value="sub.unsubscribe"');
	});

	it("links comment targets to /admin/comments/:id", () => {
		const html = renderAudit(
			[
				{
					id: "a1",
					admin_id: "u1",
					admin_name: "Op",
					action: "spam",
					target_kind: "comment",
					target_id: "01HXX000000000000000000001",
					reason: null,
					meta: null,
					created_at: 1_700_000_000_000,
				},
			],
			filters,
			null,
			adminActions,
		);
		expect(html).toContain("/admin/comments/01HXX000000000000000000001");
	});

	it("shows the empty-state row when there are no audit rows", () => {
		const html = renderAudit([], filters, null, adminActions);
		expect(html).toContain("No audit rows.");
	});

	it("renders the host dropdown populated with the supplied hosts", () => {
		const html = renderAudit([], filters, null, adminActions, [
			"blog.example.com",
			"shop.example.com",
		]);
		expect(html).toContain('<select name="host"');
		expect(html).toContain('value="blog.example.com"');
		expect(html).toContain('value="shop.example.com"');
	});

	it("shows the comment-actions-only helper text when host is active", () => {
		const html = renderAudit(
			[],
			{ ...filters, host: "blog.example.com" },
			null,
			adminActions,
			["blog.example.com"],
		);
		expect(html).toContain("narrows to comment actions on this domain");
	});

	it("omits the helper text when host is empty", () => {
		const html = renderAudit([], filters, null, adminActions, [
			"blog.example.com",
		]);
		expect(html).not.toContain("narrows to comment actions on this domain");
	});
});

describe("renderSubscriptions", () => {
	const filters: SubscriptionsFilters = {
		q: "",
		post_slug: "",
		confirmed: "",
		unsubscribed: "",
		host: "",
	};
	const makeSub = (over: Partial<Subscription> = {}): Subscription => ({
		id: "01HSUB",
		post_slug: "p1",
		email: "a@example.com",
		token: "t",
		created_at: 1_700_000_000_000,
		unsubscribed_at: null,
		last_notified_at: null,
		confirm_token: "ct",
		confirmed_at: null,
		locale: null,
		...over,
	});

	it("shows pending pill + Resend button on an unconfirmed row", () => {
		const html = renderSubscriptions([makeSub()], filters, null);
		expect(html).toContain('pill pending');
		expect(html).toContain(">Resend confirm<");
		expect(html).toContain(">Unsubscribe<");
	});

	it("hides Resend on a confirmed row but keeps Unsubscribe", () => {
		const html = renderSubscriptions(
			[makeSub({ confirmed_at: 1_700_000_001_000 })],
			filters,
			null,
		);
		expect(html).not.toContain(">Resend confirm<");
		expect(html).toContain(">Unsubscribe<");
	});

	it("hides both actions on an already-unsubscribed row", () => {
		const html = renderSubscriptions(
			[makeSub({ unsubscribed_at: 1_700_000_002_000 })],
			filters,
			null,
		);
		expect(html).not.toContain(">Resend confirm<");
		expect(html).not.toContain(">Unsubscribe<");
		expect(html).toContain("unsubscribed");
	});

	it("renders the host dropdown with the provided hosts", () => {
		const html = renderSubscriptions(
			[makeSub()],
			filters,
			null,
			["a.example.com", "b.example.com"],
		);
		expect(html).toContain('<select name="host"');
		expect(html).toContain(">a.example.com<");
		expect(html).toContain(">b.example.com<");
	});

	it("marks the selected host in the dropdown", () => {
		const html = renderSubscriptions(
			[makeSub()],
			{ ...filters, host: "b.example.com" },
			null,
			["a.example.com", "b.example.com"],
		);
		expect(html).toMatch(
			/<option value="b\.example\.com"\s+selected>b\.example\.com<\/option>/,
		);
	});

	it("preserves host across the next-page link", () => {
		const html = renderSubscriptions(
			[makeSub()],
			{ ...filters, host: "a.example.com" },
			"1700000000000|01HSUB",
			["a.example.com"],
		);
		expect(html).toMatch(/href="\/admin\/subscriptions\?[^"]*host=a\.example\.com[^"]*before=/);
	});
});

// Retention off — the default, and the shape the pre-existing operator-card
// assertions were written against. Tests that care about retention build their
// own.
const retentionOff: RetentionStats = {
	retention_days: 0,
	enabled: false,
	comments_pending: 0,
	reports_pending: 0,
	comments_total: 0,
	ghosts_total: 0,
};

const auditRetentionOff: AuditRetentionStats = {
	retention_days: 0,
	enabled: false,
	pending: 0,
	total: 0,
	oldest: null,
};

describe("renderOperator", () => {
	it("hides the seed card and explains the gate when seed_demo_allowed=false", () => {
		const html = renderOperator({
			rerender: { current_version: 1, up_to_date: 10, stale: 0, oldest_version: null },
			retention: retentionOff,
			audit_retention: auditRetentionOff,
			seed_demo_allowed: false,
		});
		expect(html).toContain("Disabled in production");
		expect(html).not.toContain(">Seed demo<");
	});

	it("shows a no-op message when stale=0 and an action button when stale>0", () => {
		const noop = renderOperator({
			rerender: { current_version: 2, up_to_date: 100, stale: 0, oldest_version: null },
			retention: retentionOff,
			audit_retention: auditRetentionOff,
			seed_demo_allowed: true,
		});
		expect(noop).toContain("all comments are at the current version");
		expect(noop).not.toContain(">Run rerender<");

		const work = renderOperator({
			rerender: { current_version: 2, up_to_date: 100, stale: 7, oldest_version: 1 },
			retention: retentionOff,
			audit_retention: auditRetentionOff,
			seed_demo_allowed: true,
		});
		expect(work).toContain(">Run rerender<");
		expect(work).toContain("oldest stale at v1");
	});

	it("derives the import size check and UI hint from MAX_IMPORT_BYTES (issue #15)", () => {
		const html = renderOperator({
			rerender: { current_version: 1, up_to_date: 10, stale: 0, oldest_version: null },
			retention: retentionOff,
			audit_retention: auditRetentionOff,
			seed_demo_allowed: false,
		});
		const mb = Math.floor(MAX_IMPORT_BYTES / (1024 * 1024));
		// Client-side size check uses the shared constant, not a literal.
		expect(html).toContain(`file.size > ${MAX_IMPORT_BYTES}`);
		// Visible hint + error message agree with it.
		expect(html).toContain(`Max upload: ${mb} MB`);
		expect(html).toContain(`file too large (max ${mb} MB)`);
	});
});

describe("renderUpdateBanner", () => {
	// Regression: the localStorage key was JSON.stringified directly into
	// both an x-data="..." and an @click="..." attribute. The first " of
	// the JSON-encoded string closed the attribute, breaking Alpine and
	// disabling the Dismiss button. Fix wraps with escapeHtml.
	it("HTML-escapes the localStorage key inside Alpine attributes", () => {
		const html = renderUpdateBanner({
			current: "v1.0.0",
			latest: "v1.2.3",
			behind: true,
			url: "https://example.com/release",
		});
		expect(html).not.toMatch(/localStorage\.getItem\("/);
		expect(html).toContain("localStorage.getItem(&quot;");
		expect(html).toContain("localStorage.setItem(&quot;");
	});

	it("returns empty string when no update is available", () => {
		expect(renderUpdateBanner(null)).toBe("");
		expect(
			renderUpdateBanner({
				current: "v1.2.3",
				latest: "v1.2.3",
				behind: false,
				url: "",
			}),
		).toBe("");
	});
});

describe("renderDashboard", () => {
	const stats: AdminStats = {
		total_comments: 42,
		pending_comments: 3,
		spam_comments: 5,
		total_users: 7,
		banned_users: 1,
	};
	const env = {} as Bindings;
	// The anti-spam summary line reads the three heuristic dials from resolved
	// settings, so the dashboard needs them alongside env.
	const dashFlags = Object.fromEntries(
		FLAG_KEYS.map((k) => [k, false]),
	) as ResolvedFlags;
	const dashNumbers = Object.fromEntries(
		NUMBER_KEYS.map((k) => [k, 0]),
	) as ResolvedNumbers;

	it("renders the spam-rate percentage and oldest-pending link", () => {
		const html = renderDashboard(
			{
				stats,
				timeline: [
					{ day: "2026-05-01", count: 2 },
					{ day: "2026-05-02", count: 5 },
				],
				top_posts: [],
				top_commenters: [],
				oldest_pending: { id: "01HOLDEST", created_at: Date.now() - 3 * 3600_000 },
				spam_rate: { total: 100, spam: 12 },
				by_host: [],
			},
			env,
			dashFlags,
			dashNumbers,
		);
		expect(html).toContain("12.0%");
		expect(html).toContain("/admin/comments/01HOLDEST");
		// the comments-per-day bar chart renders a <rect> bar per day
		expect(html).toContain("<rect");
		expect(html).toContain("Comments per day bar chart");
	});

	it("renders an empty-state message when there is no timeline", () => {
		const html = renderDashboard(
			{
				stats,
				timeline: [],
				top_posts: [],
				top_commenters: [],
				oldest_pending: null,
				spam_rate: { total: 0, spam: 0 },
				by_host: [],
			},
			env,
			dashFlags,
			dashNumbers,
		);
		expect(html).toContain("No activity in this range");
		expect(html).toContain("No pending comments");
	});

	it("renders the per-domain breakdown with spam % and links to queue", () => {
		const html = renderDashboard(
			{
				stats,
				timeline: [],
				top_posts: [],
				top_commenters: [],
				oldest_pending: null,
				spam_rate: { total: 0, spam: 0 },
				by_host: [
					{ host: "a.example.com", total: 100, pending: 3, spam: 25 },
					{ host: "b.example.com", total: 10, pending: 0, spam: 0 },
				],
			},
			env,
			dashFlags,
			dashNumbers,
		);
		expect(html).toContain("Comments by domain");
		expect(html).toContain("a.example.com");
		expect(html).toContain("25.0%");
		expect(html).toContain("0.0%");
		expect(html).toContain("/admin/queue?status=all&host=a.example.com");
	});

	it("shows '…and N more' when there are more than 10 hosts", () => {
		const hosts = Array.from({ length: 13 }, (_, i) => ({
			host: `h${i}.example.com`,
			total: 13 - i,
			pending: 0,
			spam: 0,
		}));
		const html = renderDashboard(
			{
				stats,
				timeline: [],
				top_posts: [],
				top_commenters: [],
				oldest_pending: null,
				spam_rate: { total: 0, spam: 0 },
				by_host: hosts,
			},
			env,
			dashFlags,
			dashNumbers,
		);
		expect(html).toContain("…and 3 more domains");
		expect(html).toContain("h0.example.com");
		expect(html).not.toContain("h12.example.com");
	});

	it("HTML-escapes hostile host strings in the breakdown", () => {
		const html = renderDashboard(
			{
				stats,
				timeline: [],
				top_posts: [],
				top_commenters: [],
				oldest_pending: null,
				spam_rate: { total: 0, spam: 0 },
				by_host: [
					{ host: "<svg/onload=alert(1)>", total: 1, pending: 0, spam: 0 },
				],
			},
			env,
			dashFlags,
			dashNumbers,
		);
		expect(html).not.toContain("<svg/onload=alert(1)>");
		expect(html).toContain("&lt;svg/onload=alert(1)&gt;");
	});
});

describe("renderSettings field-name contract", () => {
	// The render side (this form) and the write side (POST /admin/settings,
	// which whitelists FLAG_KEYS / NUMBER_KEYS) are wired independently. A typo
	// or rename on only one side would silently break form submission while
	// both suites still pass, so pin the rendered name/x-model bindings to the
	// exact keys the handler persists.
	const flags = Object.fromEntries(
		FLAG_KEYS.map((k) => [k, false]),
	) as ResolvedFlags;
	const numbers = Object.fromEntries(
		NUMBER_KEYS.map((k) => [k, 10]),
	) as ResolvedNumbers;
	const strings = Object.fromEntries(
		STRING_KEYS.map((k) => [k, stringDefault(k)]),
	) as ResolvedStrings;
	const texts = Object.fromEntries(
		TEXT_KEYS.map((k) => [k, ""]),
	) as ResolvedTexts;
	const html = renderSettings({} as Bindings, flags, numbers, strings, texts);

	it("emits a switch for every flag key the POST handler whitelists", () => {
		for (const key of FLAG_KEYS) {
			// `name` drives any native submit; `x-model` (= flags.<key>) is what
			// the Alpine JSON submit actually reads — pin both.
			expect(html).toContain(`name="${key}"`);
			expect(html).toContain(`x-model="flags.${key}"`);
		}
	});

	it("emits a stepper for every number key the POST handler whitelists", () => {
		for (const key of NUMBER_KEYS) {
			expect(html).toContain(`name="${key}"`);
			expect(html).toContain(`x-model.number="nums.${key}"`);
		}
	});

	it("emits a select for every string key the POST handler whitelists", () => {
		for (const key of STRING_KEYS) {
			expect(html).toContain(`name="${key}"`);
			expect(html).toContain(`x-model="strs.${key}"`);
		}
	});

	it("emits a textarea for every text key the POST handler whitelists", () => {
		for (const key of TEXT_KEYS) {
			expect(html).toContain(`name="${key}"`);
			expect(html).toContain(`x-model="texts.${key}"`);
		}
	});

	it("seeds every text key into Alpine state so save() round-trips it", () => {
		// A textarea whose key is missing from the seed binds to undefined, and
		// save() then posts `undefined` — the handler skips it, so the operator's
		// edit vanishes with a "Settings saved" toast.
		const seeded = renderSettings(
			{} as Bindings,
			flags,
			numbers,
			strings,
			Object.fromEntries(
				TEXT_KEYS.map((k) => [k, "seeded-value"]),
			) as ResolvedTexts,
		);
		for (const key of TEXT_KEYS) {
			expect(seeded).toContain(`&quot;${key}&quot;:&quot;seeded-value&quot;`);
		}
		expect(seeded).toContain("texts: this.texts");
	});

	// `texts` is the first settings group whose value is arbitrary operator
	// input rather than a boolean, a clamped number, or a whitelisted enum, so
	// it is the first that can carry characters the bare-JSON.stringify seeding
	// used by the other three does not handle. U+2028/U+2029 are the sharp ones:
	// JSON.stringify emits them raw, and they are line terminators that end the
	// string literal inside the Alpine expression, taking the whole settings
	// page's x-data with them.
	it("escapes markup and line separators in a seeded text value", () => {
		const hostile = `</script><img src=x onerror=alert(1)>\u2028\u2029"'&`;
		const seeded = renderSettings(
			{} as Bindings,
			flags,
			numbers,
			strings,
			Object.fromEntries(TEXT_KEYS.map((k) => [k, hostile])) as ResolvedTexts,
		);
		expect(seeded).not.toContain("\u2028");
		expect(seeded).not.toContain("\u2029");
		expect(seeded).toContain("\\u2028");
		// No raw angle bracket or quote survives into the attribute: they are
		// either \uXXXX-escaped by jsLiteralRaw or entity-encoded by escapeHtml.
		expect(seeded).not.toContain("<img");
		expect(seeded).not.toContain("</script>");
	});

	// The sibling test above covers hostile *data* reaching the x-data blob. This
	// one covers hostile *authoring*: the blob is a multi-line double-quoted HTML
	// attribute containing hand-written JS, so a single `"` typed anywhere in it —
	// most easily inside one of its own `//` comments — ends the attribute early.
	// The browser then parses the remainder of the object literal as attributes
	// until the first `>` (which `=>` supplies), and dumps everything after that
	// as visible text at the top of the settings page. v2.12.0 shipped exactly
	// that. Nothing else in the suite notices, because every `toContain` above
	// still passes on a page whose Alpine state never initialises.
	it("keeps the x-data attribute closed at the end of the object literal", () => {
		const attr = /x-data="([^"]*)"/.exec(html)?.[1];
		expect(attr).toBeDefined();
		// If a stray quote truncated it, the value stops mid-expression instead of
		// on the object's closing brace.
		expect(attr?.trimEnd().endsWith("}")).toBe(true);
		// And the tail of the blob really is inside the attribute, not on the page.
		expect(attr).toContain("async save()");
		expect(attr).toContain("blocklistTermCount");
	});

	it("offers only values the POST handler accepts for each string key", () => {
		// The select is the operator's whole vocabulary for these settings, and
		// the handler rejects anything off its whitelist outright — so an option
		// the handler doesn't know is a control that 400s when used.
		for (const key of STRING_KEYS) {
			const select = html.match(
				new RegExp(`<select name="${key}"[^>]*>([\\s\\S]*?)</select>`),
			);
			expect(select).not.toBeNull();
			const values = [
				...(select?.[1] ?? "").matchAll(/<option value="([^"]*)"/g),
			].map((m) => m[1]!);
			expect(values.length).toBeGreaterThan(0);
			const allowed = new Set(stringOptions(key));
			for (const v of values) expect(allowed.has(v)).toBe(true);
		}
	});

	it("does not emit a settings input bound to an unknown key", () => {
		// Catches a stray control whose name isn't in the whitelist (would be
		// silently dropped by the handler). Every checkbox/number input name
		// must be a known flag or number key.
		const known = new Set<string>([...FLAG_KEYS, ...NUMBER_KEYS]);
		const inputNames = [
			...html.matchAll(/<input\b[^>]*\bname="([^"]+)"/g),
		].map((m) => m[1]!);
		expect(inputNames.length).toBeGreaterThan(0);
		for (const name of inputNames) {
			expect(known.has(name)).toBe(true);
		}
	});

	// The fill-time dial does nothing without SPAM_FORM_TS_SECRET, and save()
	// doesn't reload the page — so the warning has to be client-reactive or it
	// stays hidden through the one transition that matters (operator raises the
	// dial off 0 and is told only "Settings saved").
	it("drives the fill-time inactive warning from Alpine state", () => {
		const off = renderSettings(
			{} as Bindings,
			flags,
			{ ...numbers, spam_honeypot_min_ms: 0 },
			strings,
			texts,
		);
		expect(off).toContain("hasFormTsSecret: false");
		expect(off).toContain(
			'x-show="nums.spam_honeypot_min_ms > 0 && !hasFormTsSecret"',
		);
		expect(off).toContain("Fill-time check is inactive.");
	});

	it("seeds hasFormTsSecret true once the secret is set", () => {
		const withSecret = renderSettings(
			{ SPAM_FORM_TS_SECRET: "s3cret" } as Bindings,
			flags,
			numbers,
			strings,
			texts,
		);
		expect(withSecret).toContain("hasFormTsSecret: true");
	});
});

/**
 * The class-level guard behind the settings-page test above.
 *
 * Every admin page hand-writes an Alpine object literal inside a double-quoted
 * `x-data="…"` attribute, so any one of them can be broken by a single stray
 * `"` — no data required, just a typo in a comment or a string. The rendered
 * test above pins settings.ts because that is where it actually happened; this
 * one scans the source of every page so the next occurrence fails in whichever
 * file introduces it, without needing a fixture per renderer.
 *
 * Scanning source rather than output is the point: building call-fixtures for
 * fourteen renderers to catch a lexical bug would be the expensive way to get a
 * worse test.
 */
describe("admin Alpine x-data attributes are lexically well-formed", () => {
	const roots = ["src/admin-ui", "src/routes"];

	const tsFiles = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
			const p = join(dir, e.name);
			return e.isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
		});

	/**
	 * Walks the template text of an `x-data="` attribute, skipping `${…}`
	 * interpolations — a `"` inside one is ordinary TypeScript and never reaches
	 * the browser, while a `"` outside one closes the attribute. Returns the
	 * literal text the browser would actually receive.
	 */
	const attrLiteral = (src: string, from: number): string => {
		let depth = 0;
		let out = "";
		for (let i = from; i < src.length; i++) {
			const c = src[i];
			if (c === "$" && src[i + 1] === "{") {
				depth++;
				i++;
			} else if (depth > 0) {
				if (c === "{") depth++;
				else if (c === "}") depth--;
			} else if (c === '"') {
				break;
			} else {
				out += c;
			}
		}
		return out;
	};

	it("never lets a stray quote close an x-data attribute early", () => {
		const offenders: string[] = [];
		for (const file of roots.flatMap(tsFiles)) {
			const src = readFileSync(file, "utf8");
			const re = /x-data="/g;
			let m: RegExpExecArray | null = re.exec(src);
			for (; m !== null; m = re.exec(src)) {
				const lit = attrLiteral(src, m.index + m[0].length);
				if (!lit.includes("{")) continue;
				// An attribute that closes where its author intended has balanced
				// braces; one truncated by a stray quote stops mid-object.
				let depth = 0;
				for (const c of lit) {
					if (c === "{") depth++;
					else if (c === "}") depth--;
				}
				if (depth !== 0) {
					const line = src.slice(0, m.index).split("\n").length;
					offenders.push(`${file}:${line} (brace depth ${depth} at close)`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("saved-reply variables in the queue reply modal", () => {
	// The composer is mounted once for the whole table, so the variable context
	// cannot be baked into it — it has to arrive with the row that opened the
	// modal. These two assertions are the ends of that wire.
	it("dispatches the row's name and post with the id", () => {
		const html = renderQueue(
			[makeComment({ author_name: "Ada", post_title: "Rolling Oasis" })],
			emptyQueueFilters,
			null,
		);
		expect(html).toContain("openReply(&quot;01HXX000000000000000000001&quot;)");
		expect(html).toContain("name: &quot;Ada&quot;");
		expect(html).toContain("post: &quot;Rolling Oasis&quot;");
		expect(html).toContain("$dispatch('open-reply', { id: id,");
	});

	it("falls back to the slug when the post has no title", () => {
		const html = renderQueue([makeComment({ post_title: null })], emptyQueueFilters, null);
		expect(html).toContain("post: &quot;hello-world&quot;");
	});

	it("feeds the modal's scope into the composer's substitution", () => {
		const html = renderQueue([makeComment()], emptyQueueFilters, null);
		expect(html).toContain("authorName = $event.detail.name || ''");
		expect(html).toContain("name: authorName, post: postTitle");
	});
});

describe("queue keyboard shortcuts", () => {
	// The one thing this feature can get quietly wrong is *promising* a key it
	// no longer handles, so the assertions run the other way round: every entry
	// in QUEUE_SHORTCUTS has to be reachable from the handler and visible to
	// the reader, rather than three hand-written lists agreeing by luck.
	const keysOf = (entry: readonly [string, string]): string[] =>
		entry[0].split("/").map((k) => k.trim());
	// The strip and the popover spell keys the way a keyboard does; the handler
	// compares KeyboardEvent.key. Only one key in the list differs, so the gap
	// is a lookup rather than a second column in QUEUE_SHORTCUTS.
	const EVENT_KEY: Record<string, string> = { Esc: "Escape" };
	const eventKey = (k: string): string => EVENT_KEY[k] ?? k;
	const adminUser: User = {
		id: "01HUSR000000000000000000A",
		provider: "github",
		provider_id: "u1",
		name: "Admin",
		email: null,
		avatar_url: null,
		is_admin: true,
		is_banned: false,
		role: "admin",
		created_at: 1_700_000_000_000,
		erased_at: null,
	};

	it("handles every key it advertises", () => {
		const html = renderQueue([makeComment()], emptyQueueFilters, null);
		for (const entry of QUEUE_SHORTCUTS) {
			for (const key of keysOf(entry)) {
				expect(html).toContain(`e.key === '${eventKey(key)}'`);
			}
		}
	});

	it("lists every advertised key in the hint strip", () => {
		const html = renderQueue([makeComment()], emptyQueueFilters, null);
		expect(html).toContain('class="muted shortcut-strip"');
		for (const entry of QUEUE_SHORTCUTS) {
			for (const key of keysOf(entry)) {
				expect(html).toContain(`<kbd>${key}</kbd>`);
			}
			expect(html).toContain(entry[1].toLowerCase());
		}
	});

	it("lists the same keys in the layout help popover", () => {
		const html = layout("Queue", "<p>body</p>", adminUser, null, {
			shortcuts: QUEUE_SHORTCUTS,
		});
		expect(html).toContain("<h4>This page</h4>");
		for (const entry of QUEUE_SHORTCUTS) {
			for (const key of keysOf(entry)) {
				expect(html).toContain(`<kbd>${key}</kbd>`);
			}
			expect(html).toContain(`<dd>${entry[1]}</dd>`);
		}
	});

	it("omits the page section when a page declares no shortcuts", () => {
		const html = layout("Users", "<p>body</p>", adminUser, null);
		expect(html).not.toContain("This page");
	});

	it("binds the handler and marks the row under the cursor", () => {
		const html = renderQueue([makeComment()], emptyQueueFilters, null);
		expect(html).toContain('@keydown.window="onKey($event)"');
		expect(html).toContain(
			":class=\"allIds[cursor] === &quot;01HXX000000000000000000001&quot; ? 'row-cursor' : ''\"",
		);
	});

	it("keeps typing, modifiers and the open modal out of the handler", () => {
		const html = renderQueue([makeComment()], emptyQueueFilters, null);
		expect(html).toContain("if (e.metaKey || e.ctrlKey || e.altKey) return;");
		expect(html).toContain("if (this.open) return;");
		expect(html).toContain(
			"t.closest('input, textarea, select, [contenteditable]')",
		);
	});

	it("confirms before delete but not before approve or spam", () => {
		const html = renderQueue([makeComment()], emptyQueueFilters, null);
		expect(html).toContain(
			"if (action === 'delete' && !confirm('Delete this comment?')) return;",
		);
	});

	it("teaches the cursor to skip every row something else hid", () => {
		const html = renderQueue([makeComment()], emptyQueueFilters, null);
		// One funnel for both hide paths: the bulk bar and a row's own buttons
		// each announce ids with `bulk-done`, and the card marks every one
		// spent. A row button that only flipped its own `gone` flag left a
		// hidden row the cursor still landed on — and then acted on twice.
		expect(html).toContain(
			'@bulk-done.window="$event.detail.ids.forEach(i => { done[i] = true; })"',
		);
		expect(html).toContain("$dispatch('bulk-done',{ids:[");
		expect(html).not.toContain("gone=true;}");
	});

	// The row's buttons and the keyboard read one table, so what's worth
	// pinning is that they still agree. Drift here is silent and it writes:
	// `a` on an approved comment re-audits it and fires a second approval
	// webhook, `s` on a deleted one quietly turns it into spam.
	const BUTTON_ACTION: Record<string, string> = {
		Approve: "approve",
		Restore: "approve",
		Spam: "spam",
		Delete: "delete",
	};
	const actionsCell = (html: string): string =>
		html.match(/<td class="actions">([\s\S]*?)<\/td>/)?.[1] ?? "";

	for (const status of ["pending", "approved", "spam", "deleted"] as const) {
		it(`offers the same actions by key as by button (${status})`, () => {
			const html = renderQueue(
				[makeComment({ status })],
				{ ...emptyQueueFilters, status },
				null,
			);
			const cell = actionsCell(html);
			const byButton = new Set(
				Object.entries(BUTTON_ACTION)
					.filter(([label]) => cell.includes(`>${label}<`))
					.map(([, action]) => action),
			);
			const byKey = Object.keys(rowActionToasts()[status] ?? {});
			expect(byKey.sort()).toEqual([...byButton].sort());
		});
	}

	it("hands the browser that table and makes the handler consult it", () => {
		const html = renderQueue([makeComment()], emptyQueueFilters, null);
		expect(html).toContain(escapeHtml(JSON.stringify(rowActionToasts())));
		expect(html).toContain(
			"const label = (this.rowActions[ctx.status] || {})[action];",
		);
	});
});

describe("comment detail reply composer", () => {
	const detail = (over: Partial<AdminComment> = {}) => ({
		comment: makeComment(over),
		parent: null,
		replies: [],
		ip_siblings: [],
		user_recent: [],
		verdicts: [],
		reports: [],
		audit: [],
	});

	// `{post}` has to name the thread the same way in both composers. It read
	// the slug here while the queue's modal read the title, which made the
	// documented title-first rule true on one page and false on the other.
	// Asserted on the substitution's own `post:` argument, because the slug
	// and the title both also appear in the page's header and links.
	it("resolves {post} to the post title", () => {
		const html = renderCommentDetail(detail({ post_title: "My Great Post" }));
		expect(html).toContain("post: &quot;My Great Post&quot;");
	});

	it("falls back to the slug when the crawler never got a title", () => {
		const html = renderCommentDetail(
			detail({ post_title: null, post_slug: "hello-world" }),
		);
		expect(html).toContain("post: &quot;hello-world&quot;");
	});
});

describe("global keyboard shortcuts", () => {
	// Same invariant as the queue's, for the three keys the popover advertises
	// on every page. This block exists because `.question-mark` shipped as a
	// dead binding: Alpine has no alias for "?", so the modifier never matched
	// and the popover promised a key nothing handled. A render test cannot
	// press a key, so it asserts the next best thing — that each advertised key
	// is compared somewhere in the handler the page actually binds.
	const adminUser: User = {
		id: "01HUSR000000000000000000A",
		provider: "github",
		provider_id: "u1",
		name: "Admin",
		email: null,
		avatar_url: null,
		is_admin: true,
		is_banned: false,
		role: "admin",
		created_at: 1_700_000_000_000,
		erased_at: null,
	};
	const render = (): string => layout("Queue", "<p>body</p>", adminUser, null);

	it("binds one hand-rolled window handler, not Alpine key modifiers", () => {
		const html = render();
		expect(html).toContain('@keydown.window="onKey($event)"');
		// The dead binding, and the two rewrites that look like fixes but are
		// not: `.shift.slash` sees e.key === "?" and misses, and a second
		// `@keydown.window` attribute would be dropped as a duplicate.
		expect(html).not.toContain("question-mark");
		expect(html).not.toContain("keydown.window.shift.slash");
		expect(html.split('@keydown.window="').length - 1).toBe(1);
	});

	it("compares every key the popover advertises", () => {
		const html = render();
		for (const [key, eventKey] of [
			["/", "/"],
			["?", "?"],
			["Esc", "Escape"],
		]) {
			expect(html).toContain(`<kbd>${key}</kbd>`);
			expect(html).toContain(`e.key === '${eventKey}'`);
		}
	});

	it("ignores modifiers and keys typed into a field, but never Escape", () => {
		const html = render();
		expect(html).toContain("if (e.ctrlKey || e.metaKey || e.altKey) return;");
		expect(html).toContain(
			"t.closest('input, textarea, select, [contenteditable]')",
		);
		// Escape is matched and returned before the guard, so a stuck popover
		// closes from inside a textarea too.
		const handler = html.slice(html.indexOf("onKey(e) {"));
		expect(handler.indexOf("e.key === 'Escape'")).toBeLessThan(
			handler.indexOf("this.typing(e)"),
		);
	});

	it("only swallows the keystroke when it has somewhere to send it", () => {
		const html = render();
		// Unconditional .prevent was the other half of the old bug: with no
		// search box on the page, "/" was eaten and nothing took focus.
		expect(html).toContain("if (el) { e.preventDefault(); el.focus(); }");
		// A hidden field counts as nowhere. Comment and user detail pages carry
		// a text input inside the saved-reply editor's x-show, so matching on
		// querySelector alone swallowed "/" on the pages where notes are typed.
		expect(html).toContain("n.offsetParent !== null");
	});
});
