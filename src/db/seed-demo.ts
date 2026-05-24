import { CURRENT_RENDERER_VERSION, renderMarkdown } from "../lib/markdown";
import { ulid } from "../lib/ulid";

const POST_SLUG = "welcome";
const POST_TITLE = "Welcome to Garrul";
const POST_URL = "https://garrul.com/welcome";

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

export type SeedDemoResult = {
	post_slug: string;
	posts_inserted: number;
	comments_inserted: number;
	users_inserted: number;
	skipped: boolean;
};

const upsertSeedUser = async (
	db: D1Database,
	name: string,
	now: number,
): Promise<{ id: string; inserted: boolean }> => {
	const provider_id = `seed:${name.toLowerCase().replace(/\s+/g, "-")}`;
	const existing = await db
		.prepare(
			`SELECT id FROM users WHERE provider = 'anon' AND provider_id = ?`,
		)
		.bind(provider_id)
		.first<{ id: string }>();
	if (existing) return { id: existing.id, inserted: false };
	const id = ulid();
	await db
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, email, avatar_url,
                          is_admin, is_banned, created_at)
       VALUES (?, 'anon', ?, ?, NULL, NULL, 0, 0, ?)`,
		)
		.bind(id, provider_id, name, now)
		.run();
	return { id, inserted: true };
};

const insertSeedComment = async (
	db: D1Database,
	user_id: string,
	post_slug: string,
	parent_id: string | null,
	body_md: string,
	now: number,
): Promise<string> => {
	const id = ulid();
	const body_html = renderMarkdown(body_md);
	await db
		.prepare(
			`INSERT INTO comments (
         id, post_slug, parent_id, user_id, body_md, body_html,
         renderer_version, status, edited_at, deleted_at,
         ip_hash, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', NULL, NULL, NULL, NULL, ?)`,
		)
		.bind(
			id,
			post_slug,
			parent_id,
			user_id,
			body_md,
			body_html,
			CURRENT_RENDERER_VERSION,
			now,
		)
		.run();
	return id;
};

const seedThread = async (
	db: D1Database,
	thread: SeedComment,
	parent_id: string | null,
	post_slug: string,
	baseTs: number,
	counter: { n: number; users: number },
): Promise<void> => {
	const now = baseTs + counter.n * 1000;
	counter.n += 1;
	const u = await upsertSeedUser(db, thread.author, now);
	if (u.inserted) counter.users += 1;
	const id = await insertSeedComment(
		db,
		u.id,
		post_slug,
		parent_id,
		thread.body,
		now,
	);
	if (thread.replies) {
		for (const reply of thread.replies) {
			await seedThread(db, reply, id, post_slug, baseTs, counter);
		}
	}
};

export const runSeedDemo = async (db: D1Database): Promise<SeedDemoResult> => {
	const now = Date.now();
	const existingPost = await db
		.prepare(`SELECT slug FROM posts WHERE slug = ?`)
		.bind(POST_SLUG)
		.first<{ slug: string }>();
	let posts_inserted = 0;
	if (!existingPost) {
		await db
			.prepare(
				`INSERT INTO posts (slug, title, url, created_at)
         VALUES (?, ?, ?, ?)`,
			)
			.bind(POST_SLUG, POST_TITLE, POST_URL, now)
			.run();
		posts_inserted = 1;
	}

	const existingCount = await db
		.prepare(`SELECT COUNT(*) AS n FROM comments WHERE post_slug = ?`)
		.bind(POST_SLUG)
		.first<{ n: number }>();
	if ((existingCount?.n ?? 0) > 0) {
		return {
			post_slug: POST_SLUG,
			posts_inserted,
			comments_inserted: 0,
			users_inserted: 0,
			skipped: true,
		};
	}

	const counter = { n: 0, users: 0 };
	for (const thread of SEED) {
		await seedThread(db, thread, null, POST_SLUG, now, counter);
	}
	return {
		post_slug: POST_SLUG,
		posts_inserted,
		comments_inserted: counter.n,
		users_inserted: counter.users,
		skipped: false,
	};
};
