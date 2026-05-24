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
import { renderQueue, type QueueFilters } from "../src/admin-ui/pages/queue";
import { renderAudit, type AuditFilters } from "../src/admin-ui/pages/audit";
import {
	renderSubscriptions,
	type SubscriptionsFilters,
} from "../src/admin-ui/pages/subscriptions";
import { renderOperator } from "../src/admin-ui/pages/operator";
import { renderDashboard } from "../src/admin-ui/pages/dashboard";
import type {
	AdminComment,
	ADMIN_ACTIONS,
	AdminStats,
	AuditRowWithAdmin,
	Subscription,
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
	author_name: "Alice",
	author_email: null,
	author_avatar_url: null,
	author_provider: "github",
	author_is_admin: false,
	author_is_banned: false,
	...over,
});

const emptyQueueFilters: QueueFilters = {
	status: "pending",
	q: "",
	post_slug: "",
	user_id: "",
	from: "",
	to: "",
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
	};
	const adminActions: typeof ADMIN_ACTIONS = [
		"approve",
		"spam",
		"delete",
		"restore",
		"edit",
		"ban",
		"unban",
		"rerender",
		"seed-demo",
		"sub.unsubscribe",
		"sub.resend",
		"bulk.approve",
		"bulk.spam",
		"bulk.delete",
		"bulk.restore",
	];

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
});

describe("renderSubscriptions", () => {
	const filters: SubscriptionsFilters = {
		q: "",
		post_slug: "",
		confirmed: "",
		unsubscribed: "",
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
});

describe("renderOperator", () => {
	it("hides the seed card and explains the gate when seed_demo_allowed=false", () => {
		const html = renderOperator({
			rerender: { current_version: 1, up_to_date: 10, stale: 0, oldest_version: null },
			seed_demo_allowed: false,
		});
		expect(html).toContain("Disabled in production");
		expect(html).not.toContain(">Seed demo<");
	});

	it("shows a no-op message when stale=0 and an action button when stale>0", () => {
		const noop = renderOperator({
			rerender: { current_version: 2, up_to_date: 100, stale: 0, oldest_version: null },
			seed_demo_allowed: true,
		});
		expect(noop).toContain("all comments are at the current version");
		expect(noop).not.toContain(">Run rerender<");

		const work = renderOperator({
			rerender: { current_version: 2, up_to_date: 100, stale: 7, oldest_version: 1 },
			seed_demo_allowed: true,
		});
		expect(work).toContain(">Run rerender<");
		expect(work).toContain("oldest stale at v1");
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
			},
			env,
		);
		expect(html).toContain("12.0%");
		expect(html).toContain("/admin/comments/01HOLDEST");
		// sparkline path renders both days
		expect(html).toContain("<path");
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
			},
			env,
		);
		expect(html).toContain("No activity in this range");
		expect(html).toContain("No pending comments");
	});
});
