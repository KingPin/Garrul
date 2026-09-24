/**
 * upsertOauthUser against REAL SQLite (every migration applied).
 *
 * Pins the two account-safety rules in its doc comment: ADMIN_EMAILS promotes
 * only on create (case-insensitive), and a later login refreshes name and
 * avatar but never email or role, so an operator's demotion sticks.
 */
import { describe, it, expect } from "vitest";
import { upsertOauthUser } from "../src/db/queries";
import { adminHarness } from "./helpers/admin-sqlite";

const ADMINS = new Set(["boss@example.com"]);

describe("upsertOauthUser", () => {
	it("promotes a new user whose email is in ADMIN_EMAILS, ignoring case", async () => {
		const { env } = adminHarness();
		const boss = await upsertOauthUser(env.DB, "github", "900", "Boss", "Boss@Example.com", null, ADMINS);
		expect(boss).toMatchObject({ role: "admin", is_admin: true, is_banned: false });
		const reader = await upsertOauthUser(env.DB, "github", "901", "Reader", null, null, ADMINS);
		expect(reader).toMatchObject({ role: "user", is_admin: false });
	});

	it("refreshes name and avatar on a repeat login but keeps email and a demotion", async () => {
		const { env, sqlite } = adminHarness();
		const first = await upsertOauthUser(env.DB, "google", "g1", "Old", "boss@example.com", null, ADMINS);
		sqlite.prepare("UPDATE users SET role = 'user', is_admin = 0 WHERE id = ?").run(first.id);

		const again = await upsertOauthUser(
			env.DB, "google", "g1", "New", "evil@example.com", "https://img.example.com/a.png", ADMINS,
		);
		expect(again.id).toBe(first.id);
		expect(sqlite.prepare("SELECT name, avatar_url, email, role FROM users WHERE id = ?").get(first.id)).toEqual({
			name: "New",
			avatar_url: "https://img.example.com/a.png",
			email: "boss@example.com",
			role: "user",
		});
		// Same provider id on a different provider is a different account.
		const other = await upsertOauthUser(env.DB, "github", "g1", "Other", null, null, ADMINS);
		expect(other.id).not.toBe(first.id);
	});

	it("does not re-promote a demoted admin who logs back in with their original allowlisted email", async () => {
		const { env, sqlite } = adminHarness();
		const first = await upsertOauthUser(env.DB, "google", "g2", "Boss", "boss@example.com", null, ADMINS);
		expect(first).toMatchObject({ role: "admin", is_admin: true });
		sqlite.prepare("UPDATE users SET role = 'user', is_admin = 0 WHERE id = ?").run(first.id);

		const again = await upsertOauthUser(env.DB, "google", "g2", "Boss", "boss@example.com", null, ADMINS);
		expect(again).toMatchObject({ role: "user", is_admin: false });
		expect(sqlite.prepare("SELECT role, is_admin FROM users WHERE id = ?").get(first.id)).toEqual({
			role: "user",
			is_admin: 0,
		});
	});
});
