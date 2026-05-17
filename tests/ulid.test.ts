/**
 * ULID critical-path tests. Two non-negotiable properties:
 *   1. Output is 26 chars Crockford alphabet.
 *   2. Two ULIDs minted in the same millisecond sort correctly (monotonic).
 */
import { describe, it, expect } from "vitest";
import { ulid } from "../src/lib/ulid";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("ulid", () => {
	it("returns a 26-char Crockford-base32 string", () => {
		const id = ulid();
		expect(id).toMatch(CROCKFORD);
	});

	it("returns distinct values on consecutive calls", () => {
		const a = ulid();
		const b = ulid();
		expect(a).not.toBe(b);
	});

	it("is monotonic within the same millisecond", () => {
		const ids: string[] = [];
		// Mint enough IDs that we're guaranteed at least two share a ms.
		for (let i = 0; i < 1000; i++) ids.push(ulid());
		const sorted = [...ids].sort();
		expect(sorted).toEqual(ids);
	});
});
