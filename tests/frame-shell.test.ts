/**
 * The static iframe shell's build inputs (scripts/frame-shell.ts). Its CSP
 * frame-ancestors is the only thing stopping any site from framing the
 * comment page, so what reaches the header is pinned here.
 */
import { describe, expect, it } from "vitest";
import { frameShellCsp, frameShellHeaders, readFrameEnv } from "../scripts/frame-shell";

const toml = (vars: string) => `name = "garrul"\n[assets]\ndirectory = "./public"\n[vars]\n${vars}\n[[d1_databases]]\nbinding = "DB"\n`;

describe("readFrameEnv", () => {
	it("skips the shell without a usable allowlist", () => {
		expect(readFrameEnv(null)).toBeNull();
		expect(readFrameEnv(toml('ENV = "production"'))).toBeNull();
		expect(readFrameEnv(toml('ALLOWED_ORIGINS = ""'))).toBeNull();
	});

	it("keeps bare http(s) origins only", () => {
		const env = readFrameEnv(
			toml('ALLOWED_ORIGINS = "https://a.example, https://b.example/path, javascript:x, *, http://c.example:8080"'),
		);
		expect(env).toEqual({ allowed: ["https://a.example", "http://c.example:8080"], dev: false });
	});

	it("reads ENV=dev", () => {
		expect(readFrameEnv(toml('ENV = "dev"\nALLOWED_ORIGINS = "https://a.example"'))?.dev).toBe(true);
	});
});

describe("frameShellCsp", () => {
	const directive = (csp: string, name: string) =>
		csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));

	it("pins framing to self and the allowlist, and allows no inline script", () => {
		const csp = frameShellCsp({ allowed: ["https://a.example"], dev: false });
		expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'self' https://a.example");
		expect(directive(csp, "script-src")).toBe(
			"script-src 'self' https://a.example https://challenges.cloudflare.com",
		);
		expect(csp).toContain("default-src 'none'");
	});

	it("lets anything frame it under ENV=dev, as the Worker route does", () => {
		const csp = frameShellCsp({ allowed: ["https://a.example"], dev: true });
		expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors *");
	});

	it("scopes the header block to /embed/ and /embed/frame.js", () => {
		const lines = frameShellHeaders({ allowed: ["https://a.example"], dev: false });
		expect(lines[0]).toBe("/embed/");
		expect(lines).toContain("/embed/frame.js");
		expect(lines.filter((l) => !l.startsWith("  ")).length).toBe(2);
	});
});
