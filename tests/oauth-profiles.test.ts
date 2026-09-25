/**
 * Provider profile parsers (PROVIDERS[*].fetch_profile), with fetch stubbed.
 *
 * The email a parser returns feeds ADMIN_EMAILS promotion and subscription
 * matching, so each provider must hand back only an address it verified —
 * GitHub's primary-verified first, Discord only when `verified`, X never.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { PROVIDERS } from "../src/lib/oauth";

// URL substring → [status, body]
const serve = (routes: Record<string, [number, unknown]>) => {
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
		const [status, body] = hit ? hit[1] : [404, {}];
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
		return new Response(JSON.stringify(body), { status });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GitHub profile", () => {
	const user: [number, unknown] = [200, { id: 7, login: "testocto", name: "  ", avatar_url: "https://a.example/o.png" }];

	it("prefers the primary verified email and falls back to the login for a blank name", async () => {
		serve({
			"/user/emails": [
				200,
				[
					{ email: "other@example.com", primary: false, verified: true },
					{ email: "main@example.com", primary: true, verified: true },
				],
			],
			"/user": user,
		});
		expect(await PROVIDERS.github.fetch_profile("tok")).toEqual({
			provider_id: "7",
			email: "main@example.com",
			name: "testocto",
			avatar_url: "https://a.example/o.png",
		});
	});

	it("takes any verified email, else none, and survives a failed email call", async () => {
		serve({
			"/user/emails": [200, [{ email: "v@example.com", primary: false, verified: true }]],
			"/user": user,
		});
		expect((await PROVIDERS.github.fetch_profile("tok")).email).toBe("v@example.com");
		serve({ "/user/emails": [200, [{ email: "u@example.com", primary: true, verified: false }]], "/user": user });
		expect((await PROVIDERS.github.fetch_profile("tok")).email).toBeNull();
		serve({ "/user/emails": [403, {}], "/user": user });
		expect((await PROVIDERS.github.fetch_profile("tok")).email).toBeNull();
		serve({ "/user": [401, {}] });
		await expect(PROVIDERS.github.fetch_profile("tok")).rejects.toThrow("github user fetch 401");
	});
});

describe("Facebook, X and Discord profiles", () => {
	it("reads Facebook's picture and falls back to the email for a name", async () => {
		serve({ "graph.facebook.com": [200, { id: "fb1", email: "f@example.com", picture: { data: { url: "https://p.example/f" } } }] });
		expect(await PROVIDERS.facebook.fetch_profile("tok")).toEqual({
			provider_id: "fb1",
			email: "f@example.com",
			name: "f@example.com",
			avatar_url: "https://p.example/f",
		});
		serve({ "graph.facebook.com": [500, {}] });
		await expect(PROVIDERS.facebook.fetch_profile("tok")).rejects.toThrow("facebook me 500");
	});

	it("never returns an email for X and upsizes its avatar", async () => {
		serve({
			"api.twitter.com": [200, { data: { id: "x1", username: "testxuser", profile_image_url: "https://p.example/a_normal.jpg" } }],
		});
		expect(await PROVIDERS.twitter.fetch_profile("tok")).toEqual({
			provider_id: "x1",
			email: null,
			name: "testxuser",
			avatar_url: "https://p.example/a.jpg",
		});
		serve({ "api.twitter.com": [200, {}] });
		await expect(PROVIDERS.twitter.fetch_profile("tok")).rejects.toThrow("no user id");
		serve({ "api.twitter.com": [429, {}] });
		await expect(PROVIDERS.twitter.fetch_profile("tok")).rejects.toThrow("twitter me 429");
	});

	it("returns Discord's email only when verified and builds the CDN avatar", async () => {
		serve({
			"discord.com": [200, { id: "d1", username: "testduser", global_name: "Dee", email: "d@example.com", verified: true, avatar: "abc" }],
		});
		expect(await PROVIDERS.discord.fetch_profile("tok")).toEqual({
			provider_id: "d1",
			email: "d@example.com",
			name: "Dee",
			avatar_url: "https://cdn.discordapp.com/avatars/d1/abc.png",
		});
		serve({ "discord.com": [200, { id: "d2", username: "testduser", email: "d@example.com", verified: false, avatar: null }] });
		expect(await PROVIDERS.discord.fetch_profile("tok")).toMatchObject({ email: null, name: "testduser", avatar_url: null });
		serve({ "discord.com": [401, {}] });
		await expect(PROVIDERS.discord.fetch_profile("tok")).rejects.toThrow("discord me 401");
	});
});
