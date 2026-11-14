/** discord_links queries + export against REAL SQLite (every migration applied). */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	deleteDiscordLinkByUser,
	exportUserData,
	getDiscordLinkByDiscordUser,
	getDiscordLinkByUser,
	upsertDiscordLink,
} from "../src/db/queries";
import { makeD1 } from "./helpers/admin-sqlite";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

const seed = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
	}
	const ins = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
		 VALUES (?, 'github', ?, ?, 0, 'admin', 1)`,
	);
	ins.run("u1", "1", "One");
	ins.run("u2", "2", "Two");
	return makeD1(sqlite);
};

const D1 = "111111111111111111";
const D2 = "222222222222222222";

describe("discord_links queries", () => {
	it("round-trips a link by discord id and by user", async () => {
		const db = seed();
		await upsertDiscordLink(db, { discord_user_id: D1, user_id: "u1" });
		expect((await getDiscordLinkByDiscordUser(db, D1))?.user_id).toBe("u1");
		expect((await getDiscordLinkByUser(db, "u1"))?.discord_user_id).toBe(D1);
	});

	it("re-linking replaces the prior link on either side", async () => {
		const db = seed();
		await upsertDiscordLink(db, { discord_user_id: D1, user_id: "u1" });
		await upsertDiscordLink(db, { discord_user_id: D2, user_id: "u1" });
		expect(await getDiscordLinkByDiscordUser(db, D1)).toBeNull();
		await upsertDiscordLink(db, { discord_user_id: D2, user_id: "u2" });
		expect(await getDiscordLinkByUser(db, "u1")).toBeNull();
		expect((await getDiscordLinkByDiscordUser(db, D2))?.user_id).toBe("u2");
	});

	it("deleteDiscordLinkByUser reports whether a row went", async () => {
		const db = seed();
		await upsertDiscordLink(db, { discord_user_id: D1, user_id: "u1" });
		expect(await deleteDiscordLinkByUser(db, "u1")).toBe(true);
		expect(await deleteDiscordLinkByUser(db, "u1")).toBe(false);
	});

	it("exportUserData includes the subject's discord_links", async () => {
		const db = seed();
		await upsertDiscordLink(db, { discord_user_id: D1, user_id: "u1" });
		const out = await exportUserData(db, "u1");
		expect(out?.discord_links).toEqual([
			expect.objectContaining({ discord_user_id: D1, user_id: "u1" }),
		]);
	});
});
