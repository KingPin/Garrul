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

	it("links the title and appends nav links when configured", async () => {
		const rows = {
			...baseRows,
			posts: { ...baseRows.posts, url: "https://blog.example.com/p" },
		};
		const out = await renderSlackBody(makeDb(rows), payload(), {
			baseUrl: "https://c.example.com",
		});
		const text = JSON.parse(out).text;
		expect(text).toContain("<https://blog.example.com/p|Hello, world!>");
		expect(text).toContain(
			"<https://c.example.com/admin/comments/01HC000000000000000000|🔍 Open in admin>",
		);
		expect(text).toContain("<https://blog.example.com/p|🌐 View page>");
	});

	it("falls back to plain title and no links when unconfigured", async () => {
		const out = await renderSlackBody(makeDb(baseRows), payload());
		const text = JSON.parse(out).text;
		expect(text).toContain("`Hello, world!`");
		expect(text).not.toContain("Open in admin");
		expect(text).not.toContain("View page");
	});
});

describe("renderDiscordBody", () => {
	it("returns JSON with an embeds array", async () => {
		const out = await renderDiscordBody(makeDb(baseRows), payload());
		const parsed = JSON.parse(out);
		expect(Array.isArray(parsed.embeds)).toBe(true);
		const embed = parsed.embeds[0];
		expect(embed.author.name).toBe("Alice");
		expect(embed.title).toBe("Hello, world!");
		expect(embed.description).toContain("Hello");
		expect(typeof embed.color).toBe("number");
		expect(embed.footer.text).toBe("Garrul");
		expect(typeof embed.timestamp).toBe("string");
	});

	it("uses a distinct accent color per event", async () => {
		const colors = new Set<number>();
		for (const event of [
			"comment.posted",
			"comment.approved",
			"comment.spam",
		] as const) {
			const out = await renderDiscordBody(makeDb(baseRows), payload({ event }));
			colors.add(JSON.parse(out).embeds[0].color);
		}
		expect(colors.size).toBe(3);
	});

	it("includes admin + page links when baseUrl and post.url are set", async () => {
		const rows = {
			...baseRows,
			posts: { ...baseRows.posts, url: "https://blog.example.com/p" },
		};
		const out = await renderDiscordBody(makeDb(rows), payload(), {
			baseUrl: "https://comments.example.com",
		});
		const embed = JSON.parse(out).embeds[0];
		expect(embed.url).toBe("https://blog.example.com/p");
		const links = embed.fields[0].value;
		expect(links).toContain(
			"https://comments.example.com/admin/comments/01HC000000000000000000",
		);
		expect(links).toContain("https://blog.example.com/p");
	});

	it("omits links when baseUrl is absent and post.url is null", async () => {
		const out = await renderDiscordBody(makeDb(baseRows), payload());
		const embed = JSON.parse(out).embeds[0];
		expect(embed.url).toBeUndefined();
		expect(embed.fields).toBeUndefined();
	});

	it("rejects non-http(s) post urls but keeps the admin link", async () => {
		const rows = {
			...baseRows,
			posts: { ...baseRows.posts, url: "javascript:alert(1)" },
		};
		const out = await renderDiscordBody(makeDb(rows), payload(), {
			baseUrl: "https://c.example.com",
		});
		const embed = JSON.parse(out).embeds[0];
		expect(embed.url).toBeUndefined();
		const links = embed.fields[0].value;
		expect(links).not.toContain("javascript:");
		expect(links).toContain("/admin/comments/");
	});

	it("defuses masked-link injection in the snippet", async () => {
		const rows = {
			...baseRows,
			comments: {
				...baseRows.comments,
				body_md: "[Win a prize](https://evil.example)",
			},
		};
		const out = await renderDiscordBody(makeDb(rows), payload());
		const desc = JSON.parse(out).embeds[0].description;
		// Brackets are escaped → Discord renders literal text, not a link.
		expect(desc).toContain("\\[Win a prize\\]");
		expect(desc).not.toContain("[Win a prize](");
	});

	it("doubles backslashes so they can't cancel the bracket escaping", async () => {
		// A leading "\" before "[" would, without backslash-doubling, turn
		// into "\\[" — a literal backslash + a *live* "[", re-enabling the
		// masked link. CodeQL flagged this incomplete-escaping bypass.
		const rows = {
			...baseRows,
			comments: {
				...baseRows.comments,
				body_md: "\\[x](https://evil.example)",
			},
		};
		const out = await renderDiscordBody(makeDb(rows), payload());
		const desc = JSON.parse(out).embeds[0].description;
		// The user's "\" is doubled and the bracket stays escaped:
		// "\\\[x\]" — Discord can't reconstruct a live masked link.
		expect(desc).toContain("\\\\\\[x\\]");
	});

	it("neutralizes @everyone and @here in the snippet", async () => {
		for (const trigger of ["@everyone", "@here"]) {
			const rows = {
				...baseRows,
				comments: { ...baseRows.comments, body_md: `Hey ${trigger} woo` },
			};
			const out = await renderDiscordBody(makeDb(rows), payload());
			const desc = JSON.parse(out).embeds[0].description;
			expect(desc).not.toMatch(new RegExp(`(?<![​])${trigger}(?!​)`));
		}
	});

	it("neutralizes role and user mentions <@…> in the snippet", async () => {
		const rows = {
			...baseRows,
			comments: {
				...baseRows.comments,
				body_md: "ping <@123456789012345678> and <@&987654321>",
			},
		};
		const out = await renderDiscordBody(makeDb(rows), payload());
		const desc = JSON.parse(out).embeds[0].description;
		expect(desc).not.toContain("<@123456789012345678>");
		expect(desc).not.toContain("<@&987654321>");
	});

	it("only sets an avatar when the user has an https avatar", async () => {
		const https = {
			...baseRows,
			users: { ...baseRows.users, avatar_url: "https://cdn.example/a.png" },
		};
		const out = await renderDiscordBody(makeDb(https), payload());
		expect(JSON.parse(out).embeds[0].author.icon_url).toBe(
			"https://cdn.example/a.png",
		);
		const insecure = {
			...baseRows,
			users: { ...baseRows.users, avatar_url: "http://cdn.example/a.png" },
		};
		const out2 = await renderDiscordBody(makeDb(insecure), payload());
		expect(JSON.parse(out2).embeds[0].author.icon_url).toBeUndefined();
	});

	it("keeps the description under Discord's 4096-char cap", async () => {
		const rows = {
			...baseRows,
			comments: { ...baseRows.comments, body_md: "x".repeat(8000) },
		};
		const out = await renderDiscordBody(makeDb(rows), payload());
		expect(JSON.parse(out).embeds[0].description.length).toBeLessThan(4096);
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
