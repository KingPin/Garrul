/**
 * Page-engagement totals (migration 0032). Bootstrap reads them on every
 * pageview, so they live beside the post and each write recounts its slice.
 * Real SQLite, every migration applied.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	castPageVote,
	countPageReactionsBySlugs,
	countPageVotesBySlugs,
	getPageVote,
	listPageReactions,
	togglePageReaction,
} from "../src/db/queries";
import { makeD1 } from "./helpers/admin-sqlite";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const apply = (sqlite: DatabaseSync, which: string[]) => {
	for (const f of which) sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
};

const SLUG = "p";
let sqlite: DatabaseSync;
let db: D1Database;

const seedPostAndUsers = (s: DatabaseSync, n: number) => {
	s.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, 't', NULL, 1)").run(SLUG);
	for (let i = 0; i < n; i++) {
		s.prepare(
			`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
			 VALUES (?, 'anon', ?, 'u', 0, 'user', 1)`,
		).run(`u${i}`, `u${i}`);
	}
};

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	apply(sqlite, files);
	seedPostAndUsers(sqlite, 3);
	db = makeD1(sqlite);
});

describe("page-engagement totals", () => {
	it("backfills totals from rows written before 0032", () => {
		const old = new DatabaseSync(":memory:");
		const i = files.indexOf("0032_page_engagement_totals.sql");
		apply(old, files.slice(0, i));
		seedPostAndUsers(old, 3);
		const react = old.prepare(
			"INSERT INTO page_reactions (post_slug, user_id, kind, created_at) VALUES (?, ?, ?, 1)",
		);
		react.run(SLUG, "u0", "fire");
		react.run(SLUG, "u1", "fire");
		react.run(SLUG, "u2", "heart");
		const vote = old.prepare(
			"INSERT INTO page_votes (post_slug, user_id, value, created_at) VALUES (?, ?, ?, 1)",
		);
		vote.run(SLUG, "u0", 1);
		vote.run(SLUG, "u1", 1);
		vote.run(SLUG, "u2", -1);

		apply(old, files.slice(i));

		expect(old.prepare("SELECT page_votes_up, page_votes_down FROM posts").get()).toEqual({
			page_votes_up: 2,
			page_votes_down: 1,
		});
		expect(
			old.prepare("SELECT kind, count FROM page_reaction_totals ORDER BY kind").all(),
		).toEqual([
			{ kind: "fire", count: 2 },
			{ kind: "heart", count: 1 },
		]);
	});

	it("reaction totals follow toggles on and off", async () => {
		await togglePageReaction(db, SLUG, "u0", "fire");
		await togglePageReaction(db, SLUG, "u1", "fire");
		expect(await listPageReactions(db, SLUG)).toEqual([{ kind: "fire", count: 2 }]);
		expect(await togglePageReaction(db, SLUG, "u0", "fire")).toEqual({ added: false });
		await togglePageReaction(db, SLUG, "u1", "fire");
		// A kind at zero is not reported, here or in the batch read.
		expect(await listPageReactions(db, SLUG)).toEqual([]);
		expect((await countPageReactionsBySlugs(db, [SLUG])).size).toBe(0);
	});

	it("vote totals follow casts, flips and clears", async () => {
		await castPageVote(db, SLUG, "u0", 1);
		await castPageVote(db, SLUG, "u1", 1);
		expect(await castPageVote(db, SLUG, "u2", -1)).toEqual({
			score_up: 2,
			score_down: 1,
			my_vote: -1,
		});
		await castPageVote(db, SLUG, "u0", -1);
		await castPageVote(db, SLUG, "u1", 0);
		expect(await getPageVote(db, SLUG, null)).toEqual({ score_up: 0, score_down: 2, my_vote: 0 });
		expect(await countPageVotesBySlugs(db, [SLUG])).toEqual(
			new Map([[SLUG, { score_up: 0, score_down: 2 }]]),
		);
	});

	it("an unknown post reads as zero", async () => {
		expect(await getPageVote(db, "nope", null)).toEqual({ score_up: 0, score_down: 0, my_vote: 0 });
		expect(await listPageReactions(db, "nope")).toEqual([]);
	});
});
