import { describe, expect, it } from "vitest";
import { publicBaseUrl } from "../src/lib/public-base";

describe("publicBaseUrl", () => {
	it("strips one trailing slash", () => {
		expect(publicBaseUrl({ PUBLIC_BASE_URL: "https://x.test/" })).toBe("https://x.test");
	});

	it("strips every trailing slash", () => {
		expect(publicBaseUrl({ PUBLIC_BASE_URL: "https://x.test///" })).toBe("https://x.test");
	});

	it("trims surrounding whitespace", () => {
		expect(publicBaseUrl({ PUBLIC_BASE_URL: "  https://x.test/ " })).toBe("https://x.test");
	});

	it("keeps a path prefix intact", () => {
		expect(publicBaseUrl({ PUBLIC_BASE_URL: "https://x.test/garrul/" })).toBe(
			"https://x.test/garrul",
		);
	});

	it("returns null for blank or unset values", () => {
		expect(publicBaseUrl({ PUBLIC_BASE_URL: " " })).toBeNull();
		expect(publicBaseUrl({ PUBLIC_BASE_URL: "" })).toBeNull();
		expect(publicBaseUrl({})).toBeNull();
	});
});
