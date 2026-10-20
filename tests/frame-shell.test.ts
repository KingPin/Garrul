/**
 * The static iframe shell's build inputs (scripts/frame-shell.ts). Its CSP
 * frame-ancestors is the only thing stopping any site from framing the
 * comment page, so what reaches the header is pinned here.
 */
import { describe, expect, it } from "vitest";
import { frameShellCsp, frameShellHeaders, readFrameEnv } from "../scripts/frame-shell";
import worker from "../src/index";

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
		expect(env).toEqual({ allowed: ["https://a.example", "http://c.example:8080"] });
	});

	it("skips under ENV=dev, which would bake frame-ancestors *", () => {
		expect(readFrameEnv(toml('ENV = "dev"\nALLOWED_ORIGINS = "https://a.example"'))).toBeNull();
	});

	it("skips when the file has [env.*] tables: the deployed env is unknown at build time", () => {
		const base = toml('ALLOWED_ORIGINS = "https://a.example"');
		expect(readFrameEnv(`${base}[env.production.vars]\nALLOWED_ORIGINS = "https://b.example"\n`)).toBeNull();
		expect(readFrameEnv(`${base}  [[env.staging.d1_databases]]\nbinding = "DB"\n`)).toBeNull();
	});
});

describe("frameShellCsp", () => {
	const directive = (csp: string, name: string) =>
		csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));

	it("pins framing to self and the allowlist, and allows no inline script", () => {
		const csp = frameShellCsp({ allowed: ["https://a.example"] });
		expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'self' https://a.example");
		expect(directive(csp, "script-src")).toBe(
			"script-src 'self' https://a.example https://challenges.cloudflare.com",
		);
		expect(csp).toContain("default-src 'none'");
	});

	it("lets the same origins frame it as the Worker route does", async () => {
		const self = "https://comments.example.com";
		const res = await worker.fetch(
			new Request(`${self}/embed/post`),
			{
				ALLOWED_ORIGINS: "https://a.example, https://b.example",
				IP_HASH_SECRET: "x",
				JWT_SECRET: "y",
			} as unknown as Record<string, unknown>,
			{} as ExecutionContext,
		);
		const workerAncestors = directive(res.headers.get("content-security-policy") ?? "", "frame-ancestors")
			?.split(" ")
			.slice(1)
			.map((o) => (o === self ? "'self'" : o))
			.sort();
		const staticAncestors = directive(
			frameShellCsp({ allowed: ["https://a.example", "https://b.example"] }),
			"frame-ancestors",
		)
			?.split(" ")
			.slice(1)
			.sort();
		expect(staticAncestors).toEqual(workerAncestors);
	});

	it("puts the CSP on every path the shell can be served at", () => {
		const lines = frameShellHeaders({ allowed: ["https://a.example"] });
		const blocks = new Map<string, string[]>();
		let path = "";
		for (const l of lines) {
			if (l.startsWith("  ")) {
				blocks.get(path)!.push(l.trim());
			} else {
				path = l;
				blocks.set(path, []);
			}
		}
		expect([...blocks.keys()]).toEqual(["/embed/", "/embed", "/embed/index.html", "/embed/frame.js"]);
		for (const p of ["/embed/", "/embed", "/embed/index.html"]) {
			expect(blocks.get(p)!.some((h) => h.startsWith("Content-Security-Policy: ") && h.includes("frame-ancestors 'self' https://a.example"))).toBe(true);
		}
		// Carries the baked allowlist, so it expires with the page.
		expect(blocks.get("/embed/frame.js")).toContain("Cache-Control: public, max-age=300");
	});
});
