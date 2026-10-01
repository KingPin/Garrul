import { describe, expect, it } from "vitest";
import { getSubdomain, putSubdomain, registerSubdomain } from "../scripts/cf-subdomain";

const reply = (body: unknown, status = 200) =>
	(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("getSubdomain", () => {
	it("returns the registered subdomain", async () => {
		const r = await getSubdomain("a", "t", reply({ success: true, result: { subdomain: "kp" } }));
		expect(r).toEqual({ ok: true, subdomain: "kp" });
	});

	it("reads an account with none as absent, not as a failure", async () => {
		const none = await getSubdomain("a", "t", reply({ success: true, result: null }));
		expect(none).toEqual({ ok: true, subdomain: null });
		const unset = await getSubdomain(
			"a",
			"t",
			reply({ success: false, errors: [{ code: 10007, message: "no subdomain" }] }, 404),
		);
		expect(unset).toEqual({ ok: true, subdomain: null });
	});

	it("reports any other failure as a failure", async () => {
		const denied = await getSubdomain(
			"a",
			"t",
			reply({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403),
		);
		expect(denied.ok).toBe(false);
		const down = await getSubdomain("a", "t", (async () => {
			throw new Error("network unreachable");
		}) as unknown as typeof fetch);
		expect(down).toEqual({ ok: false, error: "network unreachable" });
		const html = await getSubdomain("a", "t", (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch);
		expect(html.ok).toBe(false);
	});
});

describe("putSubdomain", () => {
	it("rejects an invalid name without calling the API", async () => {
		let called = false;
		const f = (async () => {
			called = true;
			return new Response("{}");
		}) as unknown as typeof fetch;
		for (const bad of ["", "Has-Caps", "-lead", "trail-", "a.b", "a b"]) {
			expect((await putSubdomain("a", "t", bad, f)).ok).toBe(false);
		}
		expect(called).toBe(false);
	});

	it("registers a valid name", async () => {
		let sent = "";
		const f = (async (_u: string, init: RequestInit) => {
			sent = `${init.method} ${init.body}`;
			return new Response(JSON.stringify({ success: true, result: { subdomain: "blog1" } }));
		}) as unknown as typeof fetch;
		expect(await putSubdomain("a", "t", "blog1", f)).toEqual({ ok: true, subdomain: "blog1" });
		expect(sent).toBe('PUT {"subdomain":"blog1"}');
	});

	it("surfaces a taken name", async () => {
		const r = await putSubdomain(
			"a",
			"t",
			"taken",
			reply({ success: false, errors: [{ code: 10019, message: "already taken" }] }, 409),
		);
		expect(r).toEqual({ ok: false, error: "already taken [code: 10019]" });
	});
});

describe("registerSubdomain", () => {
	// PUT fails (lost response), the re-read GET answers `after`.
	const lost = (after: () => Response) =>
		(async (_u: string, init: RequestInit) => {
			if (init.method === "PUT") throw new Error("connection reset");
			return after();
		}) as unknown as typeof fetch;
	const json = (b: unknown) => new Response(JSON.stringify(b));

	it("adopts a subdomain that a lost PUT already created", async () => {
		const f = lost(() => json({ success: true, result: { subdomain: "blog1" } }));
		expect(await registerSubdomain("a", "t", "blog2", f)).toEqual({ kind: "adopted", subdomain: "blog1" });
	});

	it("allows a retry only when the re-read confirms the account has none", async () => {
		const f = lost(() => json({ success: true, result: null }));
		expect(await registerSubdomain("a", "t", "taken", f)).toEqual({
			kind: "rejected",
			error: "connection reset",
		});
	});

	it("stops when the re-read fails too", async () => {
		const f = lost(() => json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }));
		expect((await registerSubdomain("a", "t", "blog2", f)).kind).toBe("unknown");
	});

	it("does not re-read after a successful PUT", async () => {
		const methods: string[] = [];
		const f = (async (_u: string, init: RequestInit) => {
			methods.push(String(init.method));
			return json({ success: true, result: { subdomain: "blog1" } });
		}) as unknown as typeof fetch;
		expect(await registerSubdomain("a", "t", "blog1", f)).toEqual({ kind: "registered", subdomain: "blog1" });
		expect(methods).toEqual(["PUT"]);
	});
});
