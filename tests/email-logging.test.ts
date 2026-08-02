/**
 * Recipient addresses must not reach the log stream (src/lib/email.ts).
 *
 * Resend's error bodies interpolate the offending field into a free-text
 * `message`, so a 422 on a bad address quotes the address itself. sendEmail
 * used to log the first 200 bytes of that body verbatim — on the digest and
 * double-opt-in paths, where the recipient is a subscriber. That is the
 * project's own "no PII in logs" rule (CLAUDE.md, Logging) broken by the one
 * module whose whole job is handling addresses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendEmail } from "../src/lib/email";

const ENV = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test" };
const VICTIM = "subscriber@example.com";

const INPUT = {
	to: VICTIM,
	from: "noreply@garrul.test",
	subject: "New reply",
	html: "<p>hi</p>",
};

const respondWith = (status: number, body: string, contentType = "application/json") =>
	vi.stubGlobal("fetch", async () =>
		new Response(body, { status, headers: { "content-type": contentType } }),
	);

describe("sendEmail — failure logging", () => {
	let lines: string[];

	beforeEach(() => {
		lines = [];
		vi.spyOn(console, "log").mockImplementation((s: unknown) => {
			lines.push(String(s));
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("logs the error code without the recipient Resend echoed back", async () => {
		respondWith(
			422,
			JSON.stringify({
				statusCode: 422,
				name: "validation_error",
				message: `Invalid \`to\` field. ${VICTIM} is not a valid recipient.`,
			}),
		);

		expect(await sendEmail(ENV, INPUT)).toBe(false);

		expect(lines).toHaveLength(1);
		const line = JSON.parse(lines[0] as string) as Record<string, unknown>;
		expect(line.msg).toBe("email.send_failed");
		expect(line.status).toBe(422);
		// The enum name is what an operator needs to tell a bad address from a
		// throttle from a bad key. The message is what leaks.
		expect(line.code).toBe("validation_error");
		expect(lines[0]).not.toContain(VICTIM);
		expect(lines[0]).not.toContain("Invalid");
	});

	it("does not leak a non-JSON error body either", async () => {
		// Resend fronts on Cloudflare; a 502 comes back as an HTML error page,
		// and an interception proxy could return anything at all.
		respondWith(502, `<html>upstream failed for ${VICTIM}</html>`, "text/html");

		expect(await sendEmail(ENV, INPUT)).toBe(false);
		expect(lines[0]).not.toContain(VICTIM);
		expect(JSON.parse(lines[0] as string).code).toBe("unparsed");
	});

	it("clamps an error name that isn't the expected enum shape", async () => {
		// The name is remote input going straight into a log line; bound it
		// rather than trusting the shape.
		respondWith(
			400,
			JSON.stringify({ name: `spoofed", "to": "${VICTIM}` }),
		);

		expect(await sendEmail(ENV, INPUT)).toBe(false);
		expect(lines[0]).not.toContain(VICTIM);
		expect(JSON.parse(lines[0] as string).code).toBe("unknown");
	});

	it("stays quiet about the recipient when the fetch itself throws", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("network unreachable");
		});

		expect(await sendEmail(ENV, INPUT)).toBe(false);
		expect(lines[0]).not.toContain(VICTIM);
	});

	it("logs nothing at all on success", async () => {
		respondWith(200, JSON.stringify({ id: "abc" }));
		expect(await sendEmail(ENV, INPUT)).toBe(true);
		expect(lines).toEqual([]);
	});
});
