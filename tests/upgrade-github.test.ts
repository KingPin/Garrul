/**
 * GitHub API access from `npm run upgrade` — pure functions, no network.
 *
 * The unauthenticated GitHub API allows 60 requests per hour per IP. An
 * operator on a shared or busy IP hits that before the upgrade script gets its
 * one call in, and the only symptom used to be a bare `returned 403`. The
 * token is optional: nothing here may fail or change shape when it is absent.
 */
import { describe, it, expect } from "vitest";
import { githubHeaders, describeGithubFailure } from "../scripts/upgrade/github";

describe("githubHeaders", () => {
	it("sends only Accept when no token is configured", () => {
		expect(githubHeaders({})).toEqual({
			Accept: "application/vnd.github+json",
		});
	});

	it("adds a Bearer header from GITHUB_TOKEN", () => {
		expect(githubHeaders({ GITHUB_TOKEN: "ghp_abc" })).toEqual({
			Accept: "application/vnd.github+json",
			Authorization: "Bearer ghp_abc",
		});
	});

	it("falls back to GH_TOKEN so `gh` users get the raise for free", () => {
		expect(githubHeaders({ GH_TOKEN: "gho_xyz" }).Authorization).toBe(
			"Bearer gho_xyz",
		);
	});

	it("prefers GITHUB_TOKEN when both are set", () => {
		expect(
			githubHeaders({ GITHUB_TOKEN: "ghp_abc", GH_TOKEN: "gho_xyz" })
				.Authorization,
		).toBe("Bearer ghp_abc");
	});

	it("treats an empty or whitespace token as unset", () => {
		expect(githubHeaders({ GITHUB_TOKEN: "" })).not.toHaveProperty(
			"Authorization",
		);
		expect(githubHeaders({ GITHUB_TOKEN: "   " })).not.toHaveProperty(
			"Authorization",
		);
		expect(githubHeaders({ GITHUB_TOKEN: "  ghp_abc " }).Authorization).toBe(
			"Bearer ghp_abc",
		);
	});
});

describe("describeGithubFailure", () => {
	const res = (status: number, headers: Record<string, string> = {}) =>
		new Response(null, { status, headers });

	it("names the rate limit when GitHub reports the cap exhausted", () => {
		const reset = Math.floor(Date.now() / 1000) + 600;
		const msg = describeGithubFailure(
			res(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }),
			"releases/latest",
			"KingPin/Garrul",
			false,
		);
		expect(msg).toContain("403");
		expect(msg).toContain("rate limit");
		expect(msg).toContain("GITHUB_TOKEN");
		expect(msg).toContain(new Date(reset * 1000).toISOString());
	});

	it("does not suggest a token that is already in use", () => {
		const msg = describeGithubFailure(
			res(403, { "x-ratelimit-remaining": "0" }),
			"releases/latest",
			"KingPin/Garrul",
			true,
		);
		expect(msg).toContain("rate limit");
		expect(msg).not.toContain("set GITHUB_TOKEN");
	});

	it("is a plain status message for any other failure", () => {
		expect(
			describeGithubFailure(res(500), "releases/latest", "KingPin/Garrul", false),
		).toBe("GitHub releases/latest returned 500 for KingPin/Garrul");
		// A 403 without the rate-limit header is not a rate limit.
		expect(
			describeGithubFailure(res(403), "releases/latest", "KingPin/Garrul", false),
		).toBe("GitHub releases/latest returned 403 for KingPin/Garrul");
	});
});
