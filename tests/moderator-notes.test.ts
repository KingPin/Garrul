/**
 * Moderator notes — POST /admin/api/notes, DELETE /admin/api/notes/:id, and
 * the card both detail pages render.
 *
 * Real SQLite with every migration applied, because the two things most worth
 * pinning here are both facts about rows: that the audit trail records *that*
 * a note was written without recording *what* it said, and that deletion is
 * author-or-admin rather than the owner-only rule saved replies use. Neither
 * survives a stubbed DB that just echoes back whatever the route bound.
 *
 * Render assertions live here too rather than in admin-render.test.ts: the
 * escaping of a note body is the same feature as the endpoint that accepts it,
 * and a note body is the only free text in this admin a *different* operator
 * wrote — the one place where "who typed this" and "who reads it" differ.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { admin, NOTE_BODY_MAX, parseNoteBody } from "../src/routes/admin";
import { moderatorNotes } from "../src/admin-ui/components/moderator-notes";
import { listModeratorNotes } from "../src/db/queries";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

const makeD1 = (db: DatabaseSync): any => ({
	prepare(sql: string) {
		const stmt = db.prepare(sql);
		let bound: unknown[] = [];
		return {
			bind(...args: unknown[]) {
				bound = args;
				return this;
			},
			async run() {
				const r = stmt.run(...(bound as never[]));
				return { success: true, meta: { changes: r.changes } };
			},
			async first() {
				return stmt.get(...(bound as never[])) ?? null;
			},
			async all() {
				return { results: stmt.all(...(bound as never[])) };
			},
		};
	},
	async batch(statements: { run(): Promise<unknown> }[]) {
		db.exec("BEGIN");
		try {
			const out = [];
			for (const s of statements) out.push(await s.run());
			db.exec("COMMIT");
			return out;
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	},
});

const ADMIN_SID = "a".repeat(64);
const MOD_SID = "b".repeat(64);
const MOD2_SID = "c".repeat(64);
const USER_SID = "d".repeat(64);

const ADMIN_ID = "01HADMIN0000000000000000AB";
const MOD_ID = "01HMOD00000000000000000MOD";
const MOD2_ID = "01HMOD2000000000000000MD2";
const PLAIN_ID = "01HUSER0000000000000000USR";

const SLUG = "hello";
const COMMENT_ID = "01HCOMMENT000000000000CMT";
const NOW = 1_700_000_000_000;

const SESSION_USER: Record<string, string> = {
	[ADMIN_SID]: ADMIN_ID,
	[MOD_SID]: MOD_ID,
	[MOD2_SID]: MOD2_ID,
	[USER_SID]: PLAIN_ID,
};

let sqlite: DatabaseSync;
let env: Bindings;

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

const makeSessions = () => ({
	async get(key: string) {
		const sid = key.replace(/^sess:/, "");
		const user_id = SESSION_USER[sid];
		if (!user_id) return null;
		return JSON.stringify({ user_id, expires_at: 4_102_444_800_000 });
	},
	async put() {},
	async delete() {},
});

const makeKv = () => {
	const store = new Map<string, string>();
	return {
		async get(key: string, type?: "json") {
			const raw = store.get(key);
			if (raw == null) return null;
			return type === "json" ? JSON.parse(raw) : raw;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		},
		async list({ prefix }: { prefix: string }) {
			return {
				keys: [...store.keys()]
					.filter((k) => k.startsWith(prefix))
					.map((name) => ({ name })),
			};
		},
	};
};

beforeEach(() => {
	installMockCaches();
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}

	const seedUser = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, email, avatar_url,
		                    is_admin, role, created_at)
		 VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
	);
	seedUser.run(ADMIN_ID, "github", "1", "Op", 1, "admin", NOW);
	seedUser.run(MOD_ID, "github", "2", "Mod One", 0, "mod", NOW);
	seedUser.run(MOD2_ID, "github", "3", "Mod Two", 0, "mod", NOW);
	seedUser.run(PLAIN_ID, "github", "4", "Reader", 0, "user", NOW);

	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, NULL, ?)")
		.run(SLUG, "Hello", NOW);
	sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
			                       renderer_version, status, ip_hash, user_agent,
			                       created_at, depth)
			 VALUES (?, ?, NULL, ?, 'hi', '<p>hi</p>', 1, 'approved', 'h', 'ua', ?, 1)`,
		)
		.run(COMMENT_ID, SLUG, PLAIN_ID, NOW);

	env = {
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
	} as unknown as Bindings;
});

afterEach(() => uninstallMockCaches());

const app = () => new Hono<{ Bindings: Bindings }>().route("/admin", admin);

const post = (body: unknown, sid = MOD_SID) =>
	app().request(
		"/admin/api/notes",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: `__Host-garrul_sess=${sid}`,
				origin: "http://localhost",
			},
			body: JSON.stringify(body),
		},
		env as unknown as Record<string, unknown>,
		execCtx,
	);

const del = (id: string, sid = MOD_SID) =>
	app().request(
		`/admin/api/notes/${id}`,
		{
			method: "DELETE",
			headers: {
				cookie: `__Host-garrul_sess=${sid}`,
				origin: "http://localhost",
			},
		},
		env as unknown as Record<string, unknown>,
		execCtx,
	);

const seedNote = (id: string, author: string, body = "seeded") => {
	sqlite
		.prepare(
			`INSERT INTO moderator_notes (id, target_kind, target_id, author_id,
			                              body, created_at)
			 VALUES (?, 'comment', ?, ?, ?, ?)`,
		)
		.run(id, COMMENT_ID, author, body, NOW);
};

const noteRows = () =>
	sqlite.prepare("SELECT * FROM moderator_notes ORDER BY id").all() as Record<
		string,
		unknown
	>[];

const auditRows = () =>
	sqlite
		.prepare(
			`SELECT admin_id, action, target_kind, target_id, reason, meta
			   FROM audit_log ORDER BY created_at, id`,
		)
		.all() as {
		admin_id: string;
		action: string;
		target_kind: string;
		target_id: string;
		reason: string | null;
		meta: string | null;
	}[];

// ------------------------------ create -------------------------------------

describe("POST /admin/api/notes", () => {
	it("lets a mod write a note on a comment", async () => {
		const res = await post({
			target_kind: "comment",
			target_id: COMMENT_ID,
			body: "left up, borderline",
		});
		expect(res.status).toBe(200);
		const rows = noteRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			target_kind: "comment",
			target_id: COMMENT_ID,
			author_id: MOD_ID,
			body: "left up, borderline",
		});
	});

	it("lets a mod write a note on a user", async () => {
		const res = await post({
			target_kind: "user",
			target_id: PLAIN_ID,
			body: "watch this one",
		});
		expect(res.status).toBe(200);
		expect(noteRows()[0]).toMatchObject({
			target_kind: "user",
			target_id: PLAIN_ID,
		});
	});

	it("audits the write against the target, carrying the note id and not the body", async () => {
		const res = await post({
			target_kind: "comment",
			target_id: COMMENT_ID,
			body: "private reasoning about a real person",
		});
		const { id } = (await res.json()) as { id: string };
		const audit = auditRows();
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			admin_id: MOD_ID,
			action: "note.create",
			target_kind: "comment",
			target_id: COMMENT_ID,
			reason: null,
		});
		expect(JSON.parse(audit[0]!.meta ?? "{}")).toEqual({ note_id: id });
		// audit_log has its own retention sweep and its own export path. A note
		// body reaching it would outlive the note and travel further than it.
		expect(JSON.stringify(audit[0])).not.toContain("private reasoning");
	});

	it("404s on a target that does not exist, without writing anything", async () => {
		const res = await post({
			target_kind: "comment",
			target_id: "01HNOSUCHCOMMENT000000000",
			body: "x",
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "target_not_found" });
		expect(noteRows()).toHaveLength(0);
		expect(auditRows()).toHaveLength(0);
	});

	it("404s on a user target that does not exist", async () => {
		const res = await post({
			target_kind: "user",
			target_id: "01HNOSUCHUSER00000000000",
			body: "x",
		});
		expect(res.status).toBe(404);
	});

	it("rejects a signed-in reader who is not a moderator", async () => {
		const res = await post(
			{ target_kind: "comment", target_id: COMMENT_ID, body: "x" },
			USER_SID,
		);
		expect(res.status).toBe(403);
		expect(noteRows()).toHaveLength(0);
	});

	it("rejects an anonymous caller", async () => {
		const res = await post(
			{ target_kind: "comment", target_id: COMMENT_ID, body: "x" },
			"e".repeat(64),
		);
		expect([401, 403]).toContain(res.status);
		expect(noteRows()).toHaveLength(0);
	});

	it("rejects a body that is not JSON", async () => {
		const res = await app().request(
			"/admin/api/notes",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: `__Host-garrul_sess=${MOD_SID}`,
					origin: "http://localhost",
				},
				body: "not json",
			},
			env as unknown as Record<string, unknown>,
			execCtx,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_body" });
	});
});

// ---------------------------- validation -----------------------------------

describe("parseNoteBody", () => {
	it("rejects a target_kind outside the two the table allows", () => {
		const r = parseNoteBody({
			target_kind: "post",
			target_id: "x",
			body: "y",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("target_kind_invalid");
	});

	it("rejects a missing target_id", () => {
		const r = parseNoteBody({
			target_kind: "user",
			target_id: "  ",
			body: "y",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("target_required");
	});

	it("rejects a whitespace-only body", () => {
		const r = parseNoteBody({
			target_kind: "user",
			target_id: "u",
			body: "   \n ",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("body_required");
	});

	it("accepts a body at the cap and rejects one char over", () => {
		const at = parseNoteBody({
			target_kind: "user",
			target_id: "u",
			body: "x".repeat(NOTE_BODY_MAX),
		});
		expect(at.ok).toBe(true);
		const over = parseNoteBody({
			target_kind: "user",
			target_id: "u",
			body: "x".repeat(NOTE_BODY_MAX + 1),
		});
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.error).toBe("body_too_long");
	});

	it("trims the stored body", () => {
		const r = parseNoteBody({
			target_kind: "user",
			target_id: " u ",
			body: "  spaced  ",
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.fields.body).toBe("spaced");
			expect(r.fields.target_id).toBe("u");
		}
	});
});

// ------------------------------ delete -------------------------------------

describe("DELETE /admin/api/notes/:id", () => {
	it("lets the author delete their own note", async () => {
		seedNote("n-mine", MOD_ID);
		const res = await del("n-mine");
		expect(res.status).toBe(200);
		expect(noteRows()).toHaveLength(0);
	});

	it("refuses a different mod, leaving the note in place", async () => {
		seedNote("n-theirs", MOD_ID);
		const res = await del("n-theirs", MOD2_SID);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "not_author" });
		expect(noteRows()).toHaveLength(1);
	});

	it("lets an admin strike another mod's note", async () => {
		// Deliberately looser than saved replies' owner-only rule: a note is a
		// claim about someone, standing in front of the whole team.
		seedNote("n-theirs", MOD_ID);
		const res = await del("n-theirs", ADMIN_SID);
		expect(res.status).toBe(200);
		expect(noteRows()).toHaveLength(0);
	});

	it("records whether the deletion was self-tidying or an admin strike", async () => {
		seedNote("n-a", MOD_ID);
		seedNote("n-b", MOD_ID);
		await del("n-a", MOD_SID);
		await del("n-b", ADMIN_SID);
		const metas = auditRows()
			.filter((r) => r.action === "note.delete")
			.map((r) => JSON.parse(r.meta ?? "{}"));
		expect(metas).toEqual([
			{ note_id: "n-a", own: true },
			{ note_id: "n-b", own: false },
		]);
	});

	it("audits the delete against the note's target, not the note", async () => {
		seedNote("n-a", MOD_ID);
		await del("n-a");
		const row = auditRows().find((r) => r.action === "note.delete");
		expect(row).toMatchObject({
			target_kind: "comment",
			target_id: COMMENT_ID,
		});
	});

	it("404s on an unknown id", async () => {
		const res = await del("n-nope");
		expect(res.status).toBe(404);
		expect(auditRows()).toHaveLength(0);
	});

	it("rejects a signed-in reader who is not a moderator", async () => {
		seedNote("n-mine", PLAIN_ID);
		const res = await del("n-mine", USER_SID);
		expect(res.status).toBe(403);
		expect(noteRows()).toHaveLength(1);
	});
});

// ------------------------------ listing ------------------------------------

describe("listModeratorNotes", () => {
	it("returns only the requested target, newest first, with author names", async () => {
		seedNote("n-old", MOD_ID, "older");
		sqlite
			.prepare(
				`INSERT INTO moderator_notes (id, target_kind, target_id, author_id,
				                              body, created_at)
				 VALUES ('n-new', 'comment', ?, ?, 'newer', ?),
				        ('n-other', 'user', ?, ?, 'elsewhere', ?)`,
			)
			.run(COMMENT_ID, MOD2_ID, NOW + 1000, PLAIN_ID, MOD_ID, NOW);
		const notes = await listModeratorNotes(env.DB, "comment", COMMENT_ID);
		expect(notes.map((n) => n.id)).toEqual(["n-new", "n-old"]);
		expect(notes[0]!.author_name).toBe("Mod Two");
		expect(notes[1]!.author_name).toBe("Mod One");
	});
});

// --------------------------- page wiring -----------------------------------

// The renderers take `notes` as an optional parameter defaulting to `[]`, so a
// route that forgot to load them would still typecheck and still render a card
// — an empty one, on every comment and every user, forever. These two hit the
// real pages.

const page = (path: string, sid: string) =>
	app().request(
		path,
		{ headers: { cookie: `__Host-garrul_sess=${sid}` } },
		env as unknown as Record<string, unknown>,
		execCtx,
	);

describe("the detail pages load their notes", () => {
	it("shows a comment's notes on /admin/comments/:id", async () => {
		seedNote("n-1", MOD_ID, "seen on the comment page");
		const res = await page(`/admin/comments/${COMMENT_ID}`, MOD_SID);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Moderator notes (1)");
		expect(html).toContain("seen on the comment page");
	});

	it("shows a user's notes on /admin/users/:id", async () => {
		sqlite
			.prepare(
				`INSERT INTO moderator_notes (id, target_kind, target_id, author_id,
				                              body, created_at)
				 VALUES ('n-u', 'user', ?, ?, 'seen on the user page', ?)`,
			)
			.run(PLAIN_ID, MOD_ID, NOW);
		const res = await page(`/admin/users/${PLAIN_ID}`, ADMIN_SID);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Moderator notes (1)");
		expect(html).toContain("seen on the user page");
	});

	it("does not leak a comment's notes onto the author's user page", async () => {
		seedNote("n-1", MOD_ID, "about the comment only");
		const res = await page(`/admin/users/${PLAIN_ID}`, ADMIN_SID);
		const html = await res.text();
		expect(html).toContain("Moderator notes (0)");
		expect(html).not.toContain("about the comment only");
	});
});

// ------------------------------- render ------------------------------------

const mkNote = (over: Record<string, unknown> = {}) => ({
	id: "01HNOTE0000000000000000NT",
	target_kind: "comment" as const,
	target_id: COMMENT_ID,
	author_id: MOD_ID,
	author_name: "Mod One",
	body: "left up, borderline",
	created_at: NOW,
	...over,
});

const render = (over: Record<string, unknown> = {}) =>
	moderatorNotes({
		target_kind: "comment",
		target_id: COMMENT_ID,
		notes: [mkNote()],
		viewerId: MOD_ID,
		viewerIsAdmin: false,
		...over,
	});

describe("moderatorNotes card", () => {
	it("escapes a hostile note body and author name", () => {
		const html = render({
			notes: [
				mkNote({
					body: "<img src=x onerror=alert(1)>",
					author_name: "<script>alert(2)</script>",
				}),
			],
		});
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
		expect(html).not.toContain("<script>alert(2)");
		expect(html).toContain("&lt;script&gt;");
	});

	it("falls back to the author id when the author row was erased", () => {
		const html = render({ notes: [mkNote({ author_name: null })] });
		expect(html).toContain(MOD_ID);
	});

	// `remove(` also names the method in the card's own x-data, so matching on
	// the bare call would pass on a card with no delete buttons at all.
	const DELETE_BUTTON = '@click="remove(';

	it("offers Delete on the viewer's own note", () => {
		expect(render()).toContain(DELETE_BUTTON);
	});

	it("withholds Delete on another mod's note from a non-admin", () => {
		const html = render({ notes: [mkNote({ author_id: MOD2_ID })] });
		expect(html).not.toContain(DELETE_BUTTON);
	});

	it("offers Delete on another mod's note to an admin", () => {
		const html = render({
			notes: [mkNote({ author_id: MOD2_ID })],
			viewerIsAdmin: true,
		});
		expect(html).toContain(DELETE_BUTTON);
	});

	it("caps the composer at the same length the endpoint enforces", () => {
		expect(render()).toContain(`maxlength="${NOTE_BODY_MAX}"`);
	});

	it("says notes are internal, so nobody writes one thinking the author sees it", () => {
		expect(render()).toMatch(/never shown to the commenter/i);
	});

	it("renders an empty state rather than a bare heading", () => {
		const html = render({ notes: [] });
		expect(html).toContain("Moderator notes (0)");
		expect(html).toMatch(/No notes yet/);
	});
});
