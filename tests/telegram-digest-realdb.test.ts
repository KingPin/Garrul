/**
 * runTelegramDigest against REAL SQLite, with the Bot API a stubbed fetch.
 *
 * The cron fires every 15 minutes; the digest self-gates to about once a day
 * through a settings row. It must not stamp that clock while nobody has opted
 * in, must stamp it after a send pass even if one chat fails, and must carry
 * counts, slugs and ages only.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { setTelegramDigest, upsertTelegramLink } from "../src/db/queries";
import { runTelegramDigest } from "../src/lib/telegram-digest";
import { ADMIN_ID, MOD_ID, adminHarness } from "./helpers/admin-sqlite";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

const setup = () => {
	const h = adminHarness();
	const sent: Array<{ chat_id: string; text: string }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			sent.push(body);
			const ok = body.chat_id !== "666";
			return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 403 });
		}),
	);
	const env = { DB: h.env.DB, TELEGRAM_BOT_TOKEN: "123:ABC", PUBLIC_BASE_URL: "https://comments.example.com/" };
	const lastSent = () =>
		(h.sqlite.prepare("SELECT value FROM settings WHERE key = 'tg_digest_last_sent_at'").get() as
			| { value: string }
			| undefined)?.value;
	return { ...h, env, sent, lastSent };
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("runTelegramDigest", () => {
	it("waits without stamping the clock while nobody has opted in", async () => {
		const { env, sent, lastSent } = setup();
		await runTelegramDigest(env, NOW);
		const { TELEGRAM_BOT_TOKEN: _token, ...noToken } = env;
		await runTelegramDigest(noToken, NOW);
		expect(sent).toEqual([]);
		expect(lastSent()).toBeUndefined();
	});

	it("sends a counts-only summary to every opted-in chat, then holds for a day", async () => {
		const { env, sqlite, sent, lastSent } = setup();
		sqlite.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES ('hot-post', 'Hot', NULL, 1)").run();
		sqlite
			.prepare(
				`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
				                       renderer_version, status, ip_hash, user_agent, created_at, depth)
				 VALUES ('c1', 'hot-post', NULL, ?, 'secret body', '<p>secret body</p>', 1, 'pending', NULL, NULL, ?, 1)`,
			)
			.run(MOD_ID, NOW - 3 * 3600 * 1000);
		sqlite
			.prepare("INSERT INTO reports (id, comment_id, reporter_user_id, reason, created_at) VALUES ('r1', 'c1', ?, 'spam', 1)")
			.run(ADMIN_ID);
		await upsertTelegramLink(env.DB, { tg_user_id: "1", tg_chat_id: "555", user_id: ADMIN_ID });
		await upsertTelegramLink(env.DB, { tg_user_id: "2", tg_chat_id: "666", user_id: MOD_ID });
		await setTelegramDigest(env.DB, ADMIN_ID, true);
		await setTelegramDigest(env.DB, MOD_ID, true);

		await runTelegramDigest(env, NOW);
		expect(sent.map((m) => m.chat_id).sort()).toEqual(["555", "666"]);
		const text = sent[0]?.text as string;
		expect(text).toContain("Pending: <b>1</b>");
		expect(text).toContain("most on <code>hot-post</code> (1)");
		expect(text).toContain("Oldest pending: <b>3h</b> old");
		expect(text).toContain('href="https://comments.example.com/admin/queue"');
		expect(text).not.toContain("secret body");
		// The failed chat still counts as a send pass.
		expect(lastSent()).toBe(String(NOW));

		await runTelegramDigest(env, NOW + DAY / 2);
		expect(sent).toHaveLength(2);
		await runTelegramDigest(env, NOW + DAY);
		expect(sent).toHaveLength(4);
	});
});
