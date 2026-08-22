/**
 * Importer core tests — the source-agnostic half of src/lib/import/.
 *
 * The Disqus adapter's own parsing and end-to-end behaviour is covered by
 * tests/disqus-import.test.ts. What lives here is everything the core does
 * for *every* adapter, exercised through a synthetic adapter so a Disqus
 * parsing change can't mask a core regression (or vice versa).
 *
 * No Miniflare. Hand-rolled D1 stub with capture, same shape as the Disqus
 * suite's.
 */
import { describe, expect, it } from "vitest";
import {
	type ImportAdapter,
	type SourceAuthor,
	type SourceExport,
	type SourceStatus,
	authorSeed,
	runImport,
} from "../src/lib/import/core";
import { asD1 } from "./helpers/d1";

type Captured = { sql: string; binds: unknown[] };

// Every "SELECT ... WHERE" misses, so inserts always proceed; every
// statement is recorded.
const makeFreshDb = () => {
	const captured: Captured[] = [];
	const chain = (sql: string) => {
		const stmt = {
			_sql: sql,
			_binds: [] as unknown[],
			bind(...args: unknown[]) {
				this._binds = args;
				return this;
			},
			async first() {
				captured.push({ sql, binds: this._binds });
				return null;
			},
			async all() {
				captured.push({ sql, binds: this._binds });
				return { results: [] };
			},
			async run() {
				captured.push({ sql, binds: this._binds });
				return { meta: { changes: 1 } };
			},
		};
		return stmt;
	};
	return { db: asD1({ prepare: chain }), captured };
};

/** An adapter that hands the core a literal export, no parsing involved. */
const stubAdapter = (source: string, exported: SourceExport): ImportAdapter => ({
	source,
	slugFallbackPrefix: `${source}-`,
	parse: () => exported,
});

const AT = 1_700_000_000_000;

/** One page, one comment per author, from a source with no author ids. */
const exportOf = (
	authors: SourceAuthor[],
	link: string | null = "https://example.com/hello",
): SourceExport => ({
	threads: [{ source_id: "t1", link, title: "Hello", created_at: AT }],
	comments: authors.map((author, i) => ({
		source_id: `c${i + 1}`,
		thread_source_id: "t1",
		parent_source_id: null,
		created_at: AT,
		status: "approved" as const,
		body_md: "hi",
		author,
	})),
});

const oneComment = (author: SourceAuthor): SourceExport => exportOf([author]);

/** The provider_id the core derived, read off the users INSERT. */
const providerIdFrom = (captured: Captured[]): string => {
	const insert = captured.find((c) => c.sql.startsWith("INSERT INTO users"));
	// Bind order: id, provider_id, name, created_at, import_source ('anon' is a literal).
	return insert!.binds[1] as string;
};

describe("authorSeed", () => {
	it("keys on name + email when the source has no author id", () => {
		expect(
			authorSeed("disqus", {
				name: "Alice",
				email: "alice@example.com",
				is_anonymous: true,
			}),
		).toBe("Alice|alice@example.com");
	});

	it("treats a missing email as empty, not as the string 'null'", () => {
		expect(
			authorSeed("disqus", { name: "Alice", email: null, is_anonymous: true }),
		).toBe("Alice|");
	});

	it("keys on the source's id when it has one, namespaced by source", () => {
		expect(
			authorSeed("remark42", {
				name: "Alice",
				email: "alice@example.com",
				is_anonymous: true,
				source_id: "github_abc123",
			}),
		).toBe("remark42:id:github_abc123");
	});

	it("ignores name and email entirely once an id is present", () => {
		// The point of the id branch: a Remark42 user who renames themselves is
		// still one ghost, and two people who pick the same display name stay
		// two.
		const a = authorSeed("remark42", {
			name: "Alice",
			email: "alice@example.com",
			is_anonymous: true,
			source_id: "u1",
		});
		const renamed = authorSeed("remark42", {
			name: "Alice Smith",
			email: null,
			is_anonymous: true,
			source_id: "u1",
		});
		const namesake = authorSeed("remark42", {
			name: "Alice",
			email: "alice@example.com",
			is_anonymous: true,
			source_id: "u2",
		});
		expect(renamed).toBe(a);
		expect(namesake).not.toBe(a);
	});

	it("namespaces the id branch so two sources' user #1 do not collide", () => {
		const seed = { name: "A", email: null, is_anonymous: true, source_id: "1" };
		expect(authorSeed("remark42", seed)).not.toBe(authorSeed("isso", seed));
	});

	it("does not namespace the name+email branch", () => {
		// Load-bearing: existing installs' provider_ids were derived from these
		// exact bytes. Prefixing them would orphan every imported ghost, so a
		// re-import would double every commenter instead of deduping.
		const seed = { name: "A", email: null, is_anonymous: true };
		expect(authorSeed("disqus", seed)).toBe(authorSeed("remark42", seed));
	});
});

describe("ghost identity derivation", () => {
	// Literal digests, not recomputed from authorSeed — that would pass even if
	// the seed changed. These are the bytes a self-hoster's `users` table
	// already holds; if this test goes red, imports stopped deduping against
	// rows they previously matched.
	it("derives provider_id from the name+email seed", async () => {
		const { db, captured } = makeFreshDb();
		await runImport(
			db,
			stubAdapter(
				"disqus",
				oneComment({
					name: "Alice",
					email: "alice@example.com",
					is_anonymous: true,
				}),
			),
			"",
			"test-secret",
		);
		expect(providerIdFrom(captured)).toBe("830d31056a671036b5303fe223975675");
	});

	it("derives provider_id from the source-id seed", async () => {
		const { db, captured } = makeFreshDb();
		await runImport(
			db,
			stubAdapter(
				"remark42",
				oneComment({
					name: "Alice",
					email: "alice@example.com",
					is_anonymous: true,
					source_id: "github_abc123",
				}),
			),
			"",
			"test-secret",
		);
		expect(providerIdFrom(captured)).toBe("aa205213947759360ea52aace2cb2e13");
	});

	it("collapses two comments by the same author onto one ghost", async () => {
		const alice = { name: "Alice", email: null, is_anonymous: true };
		const exported = exportOf([alice, { ...alice }]);
		const { db, captured } = makeFreshDb();
		const plan = await runImport(
			db,
			stubAdapter("disqus", exported),
			"",
			"test-secret",
		);
		expect(plan.new_users).toBe(1);
		expect(plan.new_comments).toBe(2);
		expect(captured.filter((c) => c.sql.startsWith("INSERT INTO users")).length)
			.toBe(1);
	});

	it("tags every row with the adapter's source, not a hard-coded 'disqus'", async () => {
		const { db, captured } = makeFreshDb();
		await runImport(
			db,
			stubAdapter(
				"remark42",
				oneComment({ name: "A", email: null, is_anonymous: true }),
			),
			"",
			"test-secret",
		);
		const comment = captured.find((c) =>
			c.sql.startsWith("INSERT INTO comments"),
		);
		expect(comment!.binds).toContain("remark42");
		expect(comment!.binds).not.toContain("disqus");
		const user = captured.find((c) => c.sql.startsWith("INSERT INTO users"));
		expect(user!.binds).toContain("remark42");
	});

	it("falls back to a source-prefixed slug when a thread has no link", async () => {
		const exported = exportOf(
			[{ name: "A", email: null, is_anonymous: true }],
			null,
		);
		const { db, captured } = makeFreshDb();
		await runImport(db, stubAdapter("remark42", exported), "", "test-secret");
		const post = captured.find((c) => c.sql.startsWith("INSERT INTO posts"));
		expect(post!.binds[0]).toBe("remark42-t1");
	});
});

describe("source moderation state", () => {
	const withStatus = (status: SourceStatus): SourceExport => {
		const e = exportOf([{ name: "A", email: null, is_anonymous: true }]);
		e.comments[0] = { ...e.comments[0]!, status };
		return e;
	};

	const importWith = async (
		status: SourceStatus,
		opts: Parameters<typeof runImport>[4] = {},
	) => {
		const { db, captured } = makeFreshDb();
		const plan = await runImport(
			db,
			stubAdapter("remark42", withStatus(status)),
			"",
			"test-secret",
			opts,
		);
		const insert = captured.find((c) =>
			c.sql.startsWith("INSERT INTO comments"),
		);
		// Bind order: id, post_slug, user_id, body_md, body_html,
		// renderer_version, status, created_at, import_source, import_id.
		return { plan, status: insert?.binds[6] as string | undefined };
	};

	it("carries the source's status onto comments.status", async () => {
		expect((await importWith("approved")).status).toBe("approved");
		expect((await importWith("pending")).status).toBe("pending");
	});

	it("imports a pending comment without needing a flag", async () => {
		// Not gated: a comment awaiting moderation is unfinished work, not junk.
		// Dropping it silently loses a call the operator never got to make.
		const { plan, status } = await importWith("pending");
		expect(plan.new_comments).toBe(1);
		expect(plan.skipped_deleted).toBe(0);
		expect(plan.skipped_spam).toBe(0);
		expect(status).toBe("pending");
	});

	it("skips spam and deleted by default", async () => {
		const spam = await importWith("spam");
		expect(spam.plan.new_comments).toBe(0);
		expect(spam.plan.skipped_spam).toBe(1);
		const gone = await importWith("deleted");
		expect(gone.plan.new_comments).toBe(0);
		expect(gone.plan.skipped_deleted).toBe(1);
	});

	it("lands spam in the spam status when include_spam is set", async () => {
		const { plan, status } = await importWith("spam", { include_spam: true });
		expect(plan.new_comments).toBe(1);
		expect(plan.skipped_spam).toBe(0);
		// Not 'approved'. The whole point of importing spam is to review it, so
		// it has to arrive somewhere a moderator looks — not published.
		expect(status).toBe("spam");
	});

	it("imports a tombstone as deleted when include_deleted is set", async () => {
		const { plan, status } = await importWith("deleted", {
			include_deleted: true,
		});
		expect(plan.new_comments).toBe(1);
		expect(plan.skipped_deleted).toBe(0);
		expect(status).toBe("deleted");
	});

	it("does not invent a deleted_at for an imported tombstone", async () => {
		const { db, captured } = makeFreshDb();
		await runImport(
			db,
			stubAdapter("remark42", withStatus("deleted")),
			"",
			"test-secret",
			{ include_deleted: true },
		);
		const insert = captured.find((c) =>
			c.sql.startsWith("INSERT INTO comments"),
		);
		// No source says when or by whom; the read path prunes on status alone.
		expect(insert!.sql).not.toContain("deleted_at");
		expect(insert!.sql).not.toContain("deleted_by");
	});
});
