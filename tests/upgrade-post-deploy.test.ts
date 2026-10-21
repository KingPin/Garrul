/**
 * Post-deploy reconcile files (src/db/post-deploy/). `npm run upgrade`
 * migrates, then deploys; between the two the old Worker writes without
 * maintaining state a migration added. The matching post-deploy file
 * recounts it once the new Worker serves.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPostDeploy } from "../scripts/upgrade";

const ROOT = join(__dirname, "..");
const MIGRATIONS = join(ROOT, "src/db/migrations");
const POST_DEPLOY = join(ROOT, "src/db/post-deploy");

beforeEach(() => {
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("runPostDeploy", () => {
	it("runs the file for each applied migration that has one, and only those", () => {
		const executeD1File = vi.fn();
		const ran = runPostDeploy(
			["0031_admin_list_indexes.sql", "0032_page_engagement_totals.sql"],
			"DB",
			{ executeD1File },
			ROOT,
		);
		const file = join(POST_DEPLOY, "0032_page_engagement_totals.sql");
		expect(executeD1File).toHaveBeenCalledExactlyOnceWith("DB", file);
		expect(ran).toEqual([file]);
	});

	it("warns and carries on when a file fails", () => {
		const executeD1File = vi.fn(() => {
			throw new Error("d1 down");
		});
		expect(runPostDeploy(["0032_page_engagement_totals.sql"], "DB", { executeD1File }, ROOT)).toEqual([]);
		expect(console.warn).toHaveBeenCalled();
	});

	it("every post-deploy file names a real migration", () => {
		const migrations = new Set(readdirSync(MIGRATIONS));
		for (const f of readdirSync(POST_DEPLOY)) expect(migrations.has(f)).toBe(true);
	});
});

describe("0032 post-deploy reconcile", () => {
	it("repairs totals the old Worker left stale, and is idempotent", () => {
		const db = new DatabaseSync(":memory:");
		for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
			db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
		}
		db.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES ('p', 't', NULL, 1)").run();
		for (const id of ["u0", "u1"]) {
			db.prepare(
				"INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at) VALUES (?, 'anon', ?, 'u', 0, 'user', 1)",
			).run(id, id);
		}
		// Totals as 0032 left them, then the old Worker's writes, which skip them.
		db.prepare("INSERT INTO page_reaction_totals (post_slug, kind, count) VALUES ('p', 'fire', 1)").run();
		db.prepare("INSERT INTO page_votes (post_slug, user_id, value, created_at) VALUES ('p', 'u0', 1, 1)").run();
		db.prepare("INSERT INTO page_reactions (post_slug, user_id, kind, created_at) VALUES ('p', 'u1', 'heart', 1)").run();

		const sql = readFileSync(join(POST_DEPLOY, "0032_page_engagement_totals.sql"), "utf8");
		db.exec(sql);
		db.exec(sql);

		expect(db.prepare("SELECT page_votes_up, page_votes_down FROM posts").get()).toEqual({
			page_votes_up: 1,
			page_votes_down: 0,
		});
		expect(db.prepare("SELECT kind, count FROM page_reaction_totals ORDER BY kind").all()).toEqual([
			{ kind: "fire", count: 0 },
			{ kind: "heart", count: 1 },
		]);
	});
});
