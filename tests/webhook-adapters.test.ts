/**
 * Slack/Discord adapter coverage. The adapters are async and touch the
 * DB, so we hand them a hand-rolled stub instead of spinning up a
 * Miniflare worker — what we're testing is the message formatting and
 * the mention-escape logic, not D1 itself.
 */
import { describe, it, expect } from "vitest";
import {
	renderDiscordBody,
	renderSlackBody,
} from "../src/lib/webhook-adapters";
import type { WebhookPayload } from "../src/lib/webhook";

// Minimal stub that mimics just enough of D1Database for the three
// query helpers we call (getComment, getUser, getPost). Each query is a
// single `prepare(...).bind(...).first()` chain, so the stub returns
// whatever we configure for the table being queried.
type Row = Record<string, unknown> | null;

const makeDb = (rows: { comments: Row; users: Row; posts: Row }) => {
	let lastSql = "";
	const stub = {
		prepare(sql: string) {
			lastSql = sql;
			return {
				bind() {
					return this;
				},
				async first() {
					if (lastSql.includes("FROM comments")) return rows.comments;
					if (lastSql.includes("FROM users")) return rows.users;
					if (lastSql.includes("FROM posts")) return rows.posts;
					return null;
				},
				async all() {
					return { results: [] };
				},
				async run() {
					return {};
				},
			};
		},
	};
	return stub as unknown as Parameters<typeof renderSlackBody>[0];
};

const payload = (
	over: Partial<WebhookPayload> = {},
): WebhookPayload => ({
	event: "comment.posted",
	comment_id: "01HC000000000000000000",
	post_slug: "hello-world",
	user_id: "01HU000000000000000000",
	ts: 1700000000000,
	...over,
});

const baseRows = {
	comments: {
		id: "01HC000000000000000000",
		post_slug: "hello-world",
		body_md: "Hello *world*",
		body_html: "<p>hello</p>",
		renderer_version: 1,
		status: "approved",
		edited_at: null,
		deleted_at: null,
		ip_hash: null,
		user_agent: null,
		created_at: 1_700_000_000_000,
		parent_id: null,
		user_id: "01HU000000000000000000",
	},
	users: {
		id: "01HU000000000000000000",
		name: "Alice",
		avatar_url: null,
		provider: "github",
		email: null,
		is_admin: 0,
		is_banned: 0,
		role: "user",
		created_at: 0,
		updated_at: 0,
	},
	posts: {
		slug: "hello-world",
		title: "Hello, world!",
		url: null,
		created_at: 0,
	},
};

describe("renderSlackBody", () => {
	it("returns a JSON string with a text field", async () => {
		const out = await renderSlackBody(makeDb(baseRows), payload());
		const parsed = JSON.parse(out);
		expect(typeof parsed.text).toBe("string");
		expect(parsed.text).toContain("New comment");
		expect(parsed.text).toContain("Alice");
		expect(parsed.text).toContain("Hello, world!");
	});

	it("uses the right verb per event", async () => {
		for (const [event, verb] of [
			["comment.posted", "New comment"],
			["comment.edited", "Edited comment"],
			["comment.deleted", "Comment deleted"],
			["comment.approved", "Comment approved"],
			["comment.spam", "Comment marked spam"],
		] as const) {
			const out = await renderSlackBody(
				makeDb(baseRows),
				payload({ event }),
			);
			expect(JSON.parse(out).text).toContain(verb);
		}
	});

	it("neutralizes @everyone in author name and body", async () => {
		const rows = {
			...baseRows,
			users: { ...baseRows.users, name: "@everyone" },
			comments: { ...baseRows.comments, body_md: "Hey @everyone look!" },
		};
		const out = await renderSlackBody(makeDb(rows), payload());
		const text = JSON.parse(out).text;
		// Either contains a zero-width space between @ and everyone,
		// OR doesn't contain the literal trigger at all.
		expect(text).not.toMatch(/(?<![​])@everyone(?!​)/);
	});

	it("neutralizes <!channel> and <@USER> tokens", async () => {
		const rows = {
			...baseRows,
			comments: {
				...baseRows.comments,
				body_md: "<!channel> please review <@U123ABC>",
			},
		};
		const out = await renderSlackBody(makeDb(rows), payload());
		const text = JSON.parse(out).text;
		expect(text).not.toContain("<!channel>");
		expect(text).not.toContain("<@U123ABC>");
		// But the visible content is preserved (with the ZWSP).
		expect(text).toContain("channel");
		expect(text).toContain("U123ABC");
	});

	it("HTML-escapes &, <, > in the snippet", async () => {
		const rows = {
			...baseRows,
			comments: { ...baseRows.comments, body_md: "<script>alert(1)&" },
		};
		const out = await renderSlackBody(makeDb(rows), payload());
		const text = JSON.parse(out).text;
		expect(text).toContain("&lt;script&gt;");
		expect(text).toContain("&amp;");
		expect(text).not.toContain("<script>");
	});

	it("truncates long bodies with an ellipsis", async () => {
		const longBody = "x".repeat(5000);
		const rows = {
			...baseRows,
			comments: { ...baseRows.comments, body_md: longBody },
		};
		const out = await renderSlackBody(makeDb(rows), payload());
		const text = JSON.parse(out).text;
		expect(text).toContain("…");
		// raw cap is 1500 + some chrome from the formatting.
		expect(text.length).toBeLessThan(2000);
	});

	it("degrades to anonymous + no-body-available when rows missing", async () => {
		const out = await renderSlackBody(
			makeDb({ comments: null, users: null, posts: null }),
			payload(),
		);
		const text = JSON.parse(out).text;
		expect(text).toContain("anonymous");
		expect(text).toContain("no body available");
	});

	it("produces valid JSON even on weird input", async () => {
		const rows = {
			...baseRows,
			users: { ...baseRows.users, name: 'A"B\\C\nD' },
		};
		const out = await renderSlackBody(makeDb(rows), payload());
		expect(() => JSON.parse(out)).not.toThrow();
	});
});

describe("renderDiscordBody", () => {
	it("returns JSON with a content field", async () => {
		const out = await renderDiscordBody(makeDb(baseRows), payload());
		const parsed = JSON.parse(out);
		expect(typeof parsed.content).toBe("string");
		expect(parsed.content).toContain("New comment");
		expect(parsed.content).toContain("Alice");
	});

	it("neutralizes @everyone and @here", async () => {
		for (const trigger of ["@everyone", "@here"]) {
			const rows = {
				...baseRows,
				comments: { ...baseRows.comments, body_md: `Hey ${trigger} woo` },
			};
			const out = await renderDiscordBody(makeDb(rows), payload());
			const content = JSON.parse(out).content;
			expect(content).not.toMatch(
				new RegExp(`(?<![​])${trigger}(?!​)`),
			);
		}
	});

	it("neutralizes role and user mentions <@…>", async () => {
		const rows = {
			...baseRows,
			comments: {
				...baseRows.comments,
				body_md: "ping <@123456789012345678> and <@&987654321>",
			},
		};
		const out = await renderDiscordBody(makeDb(rows), payload());
		const content = JSON.parse(out).content;
		expect(content).not.toContain("<@123456789012345678>");
		expect(content).not.toContain("<@&987654321>");
	});

	it("stays under Discord's 2000-char content cap", async () => {
		const rows = {
			...baseRows,
			comments: { ...baseRows.comments, body_md: "x".repeat(8000) },
		};
		const out = await renderDiscordBody(makeDb(rows), payload());
		const content = JSON.parse(out).content;
		expect(content.length).toBeLessThan(2000);
	});

	it("produces valid JSON for newline + quote-laden bodies", async () => {
		const rows = {
			...baseRows,
			comments: {
				...baseRows.comments,
				body_md: 'first line\n"second" line\nthird',
			},
		};
		const out = await renderDiscordBody(makeDb(rows), payload());
		expect(() => JSON.parse(out)).not.toThrow();
	});
});
