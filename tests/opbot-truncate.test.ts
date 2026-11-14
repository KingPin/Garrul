import { describe, expect, it } from "vitest";
import { truncateCodePoints } from "../src/lib/opbot/cards";

describe("truncateCodePoints", () => {
	it("keeps short strings and cuts on code points, never inside a surrogate pair", () => {
		expect(truncateCodePoints("abc", 5)).toBe("abc");
		const s = `${"a".repeat(199)}😀tail`;
		expect(s.slice(0, 200).endsWith("\ud83d")).toBe(true); // UTF-16 slice splits the emoji
		const cut = truncateCodePoints(s, 200);
		expect(cut).toBe(`${"a".repeat(199)}😀`);
		expect(Array.from(cut)).toHaveLength(200);
		expect(truncateCodePoints(s, 199)).toBe("a".repeat(199));
	});
});

describe("replyRefusalText", () => {
	it("matches the wording both bots show", async () => {
		const { replyRefusalText } = await import("../src/lib/opbot/reply");
		expect(replyRefusalText("comment_not_found")).toBe("That comment no longer exists.");
		expect(replyRefusalText("body_too_long", 4000)).toBe("Reply too long (max 4000 characters).");
		expect(replyRefusalText("saved_reply_not_visible")).toBe("That saved reply isn't available here.");
	});
});
