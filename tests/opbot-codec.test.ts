import { describe, expect, it } from "vitest";
import { buttonsFor, type OpButton } from "../src/lib/opbot/cards";
import {
	decodePayload,
	encodePayload,
	OP_ACTIONS,
} from "../src/lib/opbot/codec";

const U = "01HC0000000000000000000000";
const P = "01HP0000000000000000000000";

describe("opbot codec", () => {
	it("round-trips every action", () => {
		for (const a of OP_ACTIONS) {
			const id = a === "rv" ? "-" : U;
			expect(decodePayload(encodePayload("discord", a, id, ["q"]))).toEqual({
				action: a,
				commentId: id,
				extra: ["q"],
			});
		}
	});
	it("round-trips 0 and 3 extras", () => {
		expect(decodePayload(encodePayload("discord", "pick", U))?.extra).toEqual([]);
		expect(
			decodePayload(encodePayload("discord", "pick", U, ["a", "b", "c"]))?.extra,
		).toEqual(["a", "b", "c"]);
	});
	it("rejects bad payloads", () => {
		for (const bad of [
			`x:approve:${U}`,
			`g:nope:${U}`,
			"g:approve:",
			`g:rv:${U}`,
			undefined,
		])
			expect(decodePayload(bad as string)).toBeNull();
	});
	it("fits the longest payloads", () => {
		expect(new TextEncoder().encode(encodePayload("telegram", "sr", U, [P])).length).toBe(58);
		expect(encodePayload("telegram", "restore", U, ["q"]).length).toBe(38);
		const snowflake = "12345678901234567890";
		expect(encodePayload("discord", "rsub", U, [snowflake, P]).length).toBeLessThanOrEqual(100);
	});
	it("throws past the limit", () => {
		expect(() => encodePayload("telegram", "sr", U, [P, "x".repeat(10)])).toThrow(RangeError);
	});
	it("buttonsFor follows status", () => {
		const actions = (rows: OpButton[][]) => rows.map((r) => r.map((b) => b.action));
		expect(actions(buttonsFor("pending", { reported: false }))).toEqual([
			["approve", "spam"],
			["delete", "ban", "reply"],
		]);
		expect(actions(buttonsFor("approved", { reported: true }))).toEqual([
			["spam"],
			["delete", "ban", "reply", "resolve"],
		]);
		expect(actions(buttonsFor("spam", { reported: false }))[0]).toEqual(["restore"]);
		expect(actions(buttonsFor("pending", { reported: false, queue: true })).at(-1)).toEqual(["nx"]);
	});
});
