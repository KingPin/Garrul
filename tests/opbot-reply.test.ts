/** Shared moderator reply core (src/lib/opbot/reply.ts), real SQLite. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/webhook", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/webhook")>()),
	fireWebhook: vi.fn(),
}));

import { getUser, insertComment } from "../src/db/queries";
import { CURRENT_RENDERER_VERSION } from "../src/lib/markdown";
import {
	expandPreset,
	pickerPresets,
	postModeratorReply,
	presetVars,
} from "../src/lib/opbot/reply";
import { MAX_REPLY_DEPTH } from "../src/lib/tree";
import { fireWebhook } from "../src/lib/webhook";
import { ADMIN_ID, MOD_ID, adminHarness } from "./helpers/admin-sqlite";

type H = ReturnType<typeof adminHarness>;
let h: H;
const actor = async () => (await getUser((h.env as any).DB, MOD_ID))!;

const seed = async (opts: { depth?: number; status?: string } = {}) =>
	(
		await insertComment((h.env as any).DB, {
			post_slug: "hello",
			parent_id: null,
			user_id: ADMIN_ID,
			body_md: "c",
			body_html: "<p>c</p>",
			renderer_version: CURRENT_RENDERER_VERSION,
			status: (opts.status ?? "approved") as never,
			ip_hash: null,
			user_agent: null,
			depth: opts.depth ?? 0,
		})
	).id;

const count = () =>
	(h.sqlite.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;

const preset = (id: string, owner: string, scope: string) =>
	h.sqlite
		.prepare(
			`INSERT INTO saved_replies (id, owner_id, title, body_md, scope, created_at, updated_at)
			 VALUES (?, ?, 'P', 'b', ?, 1, 1)`,
		)
		.run(id, owner, scope);

const reply = async (commentId: string, extra: Record<string, unknown> = {}) =>
	postModeratorReply({
		env: h.env,
		reqUrl: "http://localhost/admin",
		actor: await actor(),
		commentId,
		bodyMd: "thanks",
		notify: false,
		...extra,
	});

beforeEach(() => {
	h = adminHarness();
	h.sqlite
		.prepare("INSERT INTO posts (slug, title, created_at) VALUES ('hello', 'Hello Post', 1)")
		.run();
	vi.mocked(fireWebhook).mockClear();
});

describe("postModeratorReply", () => {
	it("refuses a deleted target", async () => {
		const id = await seed({ status: "deleted" });
		const before = count();
		expect(await reply(id)).toEqual({ ok: false, error: "comment_deleted" });
		expect(count()).toBe(before);
	});

	it("refuses past MAX_REPLY_DEPTH", async () => {
		const id = await seed({ depth: MAX_REPLY_DEPTH });
		expect(await reply(id)).toEqual({ ok: false, error: "thread_too_deep" });
	});

	it("refuses unknown target, empty body and invisible saved reply", async () => {
		const id = await seed();
		expect(await reply("nope")).toEqual({ ok: false, error: "comment_not_found" });
		expect(await reply(id, { bodyMd: "  " })).toEqual({ ok: false, error: "body_required" });
		preset("sr1", ADMIN_ID, "private");
		expect(await reply(id, { savedReplyId: "sr1" })).toEqual({
			ok: false,
			error: "saved_reply_not_visible",
		});
		expect(count()).toBe(1);
	});

	it("posts and audits", async () => {
		const id = await seed();
		const res = await reply(id);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const row = h.sqlite.prepare("SELECT * FROM comments WHERE id = ?").get(res.id) as any;
		expect(row).toMatchObject({
			status: "approved",
			parent_id: id,
			user_id: MOD_ID,
			as_staff: 1,
		});
		expect(
			(h.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='comment.reply'").get() as any).n,
		).toBe(1);
		expect(fireWebhook).toHaveBeenCalledTimes(1);
	});
});

describe("saved reply picker", () => {
	it("group picker hides private presets", async () => {
		preset("mine", MOD_ID, "private");
		preset("theirs", ADMIN_ID, "private");
		preset("shared", ADMIN_ID, "shared");
		const db = (h.env as any).DB;
		const ids = async (chat: "group" | "private") =>
			(await pickerPresets(db, MOD_ID, { chat })).map((p) => p.id).sort();
		expect(await ids("group")).toEqual(["shared"]);
		expect(await ids("private")).toEqual(["mine", "shared"]);
	});

	it("expandPreset leaves missing vars literal", () => {
		expect(
			expandPreset("Hi {name} re {post} — {mod}", { name: undefined, post: "T", mod: "M" }),
		).toBe("Hi {name} re T — M");
	});

	it("presetVars resolves author, post title and mod; missing stays undefined", async () => {
		const id = await seed();
		expect(await presetVars(h.env, id, await actor())).toEqual({
			name: "Op",
			post: "Hello Post",
			mod: "Mod",
		});
		expect(await presetVars(h.env, "nope", await actor())).toEqual({
			name: undefined,
			post: undefined,
			mod: "Mod",
		});
	});
});
