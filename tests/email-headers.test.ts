/**
 * `sendEmail` forwards message headers into the Resend request body.
 *
 * The distinction this pins is the one that is easy to get wrong in
 * src/lib/email.ts: the fetch call already has a `headers` object, and those
 * are the headers on the request *to Resend* (authorization, content-type).
 * `input.headers` are headers on the message Resend then sends, and Resend
 * takes them as a field in the POST body. Setting them on the wrong object
 * would authenticate fine and silently ship mail with no List-Unsubscribe.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../src/lib/email";

const ENV = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test" };

const INPUT = {
	to: "subscriber@example.com",
	from: "noreply@garrul.test",
	subject: "New reply",
	html: "<p>hi</p>",
};

/** Stubs fetch, answers 200, and hands back the one request that was made. */
const capture = (): (() => RequestInit) => {
	const calls: RequestInit[] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		calls.push(init);
		return new Response(JSON.stringify({ id: "abc" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	return () => {
		const init = calls[0];
		if (!init) throw new Error("sendEmail made no request");
		return init;
	};
};

const bodyOf = (init: RequestInit): Record<string, unknown> =>
	JSON.parse(String(init.body)) as Record<string, unknown>;

describe("sendEmail — message headers", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("puts input.headers in the request body, not on the request headers", async () => {
		const sent = capture();
		const headers = {
			"List-Unsubscribe": "<https://comments.example.com/u/abc>",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		};

		expect(await sendEmail(ENV, { ...INPUT, headers })).toBe(true);

		expect(bodyOf(sent()).headers).toEqual(headers);
		// The request's own headers stay exactly what they were.
		expect(sent().headers).toEqual({
			authorization: "Bearer re_test",
			"content-type": "application/json",
		});
	});

	it("omits the field entirely when no headers are given", async () => {
		const sent = capture();

		expect(await sendEmail(ENV, INPUT)).toBe(true);

		// Not `headers: undefined` — an explicit null-ish field is a shape
		// Resend has no reason to see, and `text` is already handled this way.
		expect(bodyOf(sent())).not.toHaveProperty("headers");
	});
});
