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

	it("strips a trailing mix of slashes and whitespace", () => {
		expect(publicBaseUrl({ PUBLIC_BASE_URL: "https://x.test/ / /\t" })).toBe("https://x.test");
	});

	it("stays linear on a long internal whitespace run", () => {
		const start = performance.now();
		publicBaseUrl({ PUBLIC_BASE_URL: `https://x.test${" ".repeat(100_000)}x` });
		expect(performance.now() - start).toBeLessThan(100);
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
