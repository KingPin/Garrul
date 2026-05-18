#!/usr/bin/env tsx
/**
 * Seed a "welcome" demo post with a small comment thread.
 *
 *   npm run seed-demo              # local D1 (Miniflare)
 *   npm run seed-demo -- --remote  # production D1 (intended for comments.garrul.com)
 *
 * Idempotent: re-running clears the welcome post's existing comments and
 * re-seeds. The post row itself uses an upsert.
 *
 * Intended for the maintainer's demo instance only. Do not run against a
 * production deployment that already has real traffic.
 */
import { execFileSync } from "node:child_process";

import {
	CURRENT_RENDERER_VERSION,
	renderMarkdown,
} from "../src/lib/markdown";
import { ulid } from "../src/lib/ulid";

const DB_NAME = "garrul-db";
const isRemote = process.argv.includes("--remote");
const remoteFlag = isRemote ? "--remote" : "--local";
if (!isRemote) {
	console.warn(
		"[seed-demo] running against LOCAL D1 (Miniflare). " +
			"Pass --remote to seed the deployed instance (intended for the " +
			"maintainer's demo only — wipes existing welcome-post comments).",
	);
}
const POST_SLUG = "welcome";
const POST_TITLE = "Welcome to Garrul";
const POST_URL = "https://garrul.com/welcome";

const runWrangler = (args: string[]): string =>
	execFileSync("wrangler", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

const sqlEsc = (s: string): string => s.replace(/'/g, "''");

const d1Execute = (sql: string): void => {
	runWrangler([
		"d1",
		"execute",
		DB_NAME,
		remoteFlag,
		"--command",
		sql,
	]);
};

type SeedComment = {
	author: string;
	body: string;
	replies?: SeedComment[];
};

const SEED: SeedComment[] = [
	{
		author: "Garrul Bot",
		body:
			"Welcome! This is **Garrul**, a self-hosted comment system on " +
			"Cloudflare Workers. Threaded, markdown-aware, no tracking.",
		replies: [
			{
				author: "Ada",
				body:
					"Looks great. How does it handle Safari's third-party cookie " +
					"blocking?",
				replies: [
					{
						author: "Garrul Bot",
						body:
							"Session cookies are `SameSite=None; Secure; Partitioned` " +
							"(CHIPS). Works in Safari and Chrome.",
					},
				],
			},
			{
				author: "Marvin",
				body: "Markdown sample: `code`, **bold**, _italic_, and a [link](https://example.com).",
			},
		],
	},
	{
		author: "Linus",
		body:
			"Try replying to this comment. The depth cap is six — beyond that, " +
			"replies render flat with an `@parent` prefix.",
	},
];

const upsertPost = (slug: string, title: string, url: string, now: number) => {
	const sql = `INSERT INTO posts (slug, title, url, created_at)
	             VALUES ('${sqlEsc(slug)}', '${sqlEsc(title)}', '${sqlEsc(url)}', ${now})
	             ON CONFLICT(slug) DO UPDATE SET
	               title = excluded.title,
	               url   = excluded.url`;
	d1Execute(sql);
};

const wipeExistingComments = (slug: string) => {
	d1Execute(`DELETE FROM comments WHERE post_slug = '${sqlEsc(slug)}'`);
};

const insertSeedUser = (name: string, now: number): string => {
	const id = ulid();
	const provider_id = `seed:${name.toLowerCase().replace(/\s+/g, "-")}`;
	const sql = `INSERT INTO users (id, provider, provider_id, name, email,
	                                 avatar_url, is_admin, is_banned, created_at)
	             VALUES ('${id}', 'anon', '${sqlEsc(provider_id)}',
	                     '${sqlEsc(name)}', NULL, NULL, 0, 0, ${now})
	             ON CONFLICT(provider, provider_id) DO UPDATE SET name = excluded.name`;
	d1Execute(sql);
	const lookup = runWrangler([
		"d1",
		"execute",
		DB_NAME,
		remoteFlag,
		"--json",
		"--command",
		`SELECT id FROM users WHERE provider = 'anon' AND provider_id = '${sqlEsc(provider_id)}'`,
	]);
	try {
		const parsed = JSON.parse(lookup) as Array<{ results?: Array<{ id: string }> }>;
		const found = parsed?.[0]?.results?.[0]?.id;
		if (found) return found;
	} catch {
		// fall through
	}
	return id;
};

const insertSeedComment = (
	user_id: string,
	post_slug: string,
	parent_id: string | null,
	body_md: string,
	now: number,
): string => {
	const id = ulid();
	const body_html = renderMarkdown(body_md);
	const parent_clause = parent_id ? `'${sqlEsc(parent_id)}'` : "NULL";
	const sql = `INSERT INTO comments (
	               id, post_slug, parent_id, user_id, body_md, body_html,
	               renderer_version, status, edited_at, deleted_at,
	               ip_hash, user_agent, created_at)
	             VALUES ('${id}', '${sqlEsc(post_slug)}', ${parent_clause},
	                     '${sqlEsc(user_id)}', '${sqlEsc(body_md)}',
	                     '${sqlEsc(body_html)}', ${CURRENT_RENDERER_VERSION},
	                     'approved', NULL, NULL, NULL, NULL, ${now})`;
	d1Execute(sql);
	return id;
};

const seedThread = (
	thread: SeedComment,
	parent_id: string | null,
	post_slug: string,
	baseTs: number,
	counter: { n: number },
) => {
	const now = baseTs + counter.n * 1000;
	counter.n += 1;
	const user_id = insertSeedUser(thread.author, now);
	const id = insertSeedComment(user_id, post_slug, parent_id, thread.body, now);
	if (thread.replies) {
		for (const reply of thread.replies) {
			seedThread(reply, id, post_slug, baseTs, counter);
		}
	}
};

const main = () => {
	console.log(`[seed-demo] target ${remoteFlag}, post '${POST_SLUG}'`);
	const now = Date.now();
	upsertPost(POST_SLUG, POST_TITLE, POST_URL, now);
	wipeExistingComments(POST_SLUG);
	const counter = { n: 0 };
	for (const thread of SEED) {
		seedThread(thread, null, POST_SLUG, now, counter);
	}
	console.log(`[seed-demo] done (${counter.n} comments)`);
};

try {
	main();
} catch (err) {
	console.error("[seed-demo] failed:", err);
	process.exit(1);
}
