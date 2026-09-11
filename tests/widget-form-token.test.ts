/**
 * The widget skips the form-token request when config says the route would
 * 404. Only an explicit `false` skips: an older server that does not send the
 * field keeps the legacy fetch, because on that server the route may be live.
 */
import { describe, it, expect } from "vitest";
import { formTokenWanted } from "../src/widget/boot";

describe("formTokenWanted", () => {
	it("keeps the legacy fetch when the field is missing", () => {
		expect(formTokenWanted(undefined)).toBe(true);
		expect(formTokenWanted(null)).toBe(true);
		expect(formTokenWanted({})).toBe(true);
	});

	it("fetches when the server says the check is on", () => {
		expect(formTokenWanted({ form_token_enabled: true })).toBe(true);
	});

	it("skips only on an explicit false", () => {
		expect(formTokenWanted({ form_token_enabled: false })).toBe(false);
	});
});
