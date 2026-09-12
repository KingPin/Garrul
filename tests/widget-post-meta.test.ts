/**
 * The post metadata the widget attaches to every comment create, read off the
 * host element's data-* attributes. `post_published` anchors age-based
 * auto-close on the server; the server records it only on the request that
 * creates the post row, so the widget must send it on every create (it cannot
 * know which one is first).
 */
import { describe, it, expect } from "vitest";
import { postMetaFromDataset } from "../src/widget/boot";

describe("postMetaFromDataset", () => {
	it("passes title, url and published through", () => {
		expect(
			postMetaFromDataset({
				title: "Hello",
				url: "https://example.com/hello/",
				published: "2026-09-11T12:00:00Z",
			}),
		).toEqual({
			post_title: "Hello",
			post_url: "https://example.com/hello/",
			post_published: "2026-09-11T12:00:00Z",
		});
	});

	it("maps missing attributes to null", () => {
		expect(postMetaFromDataset({})).toEqual({
			post_title: null,
			post_url: null,
			post_published: null,
		});
	});

	it("ignores unrelated data-* attributes", () => {
		expect(postMetaFromDataset({ slug: "x", api: "https://c.example", title: "T" })).toEqual({
			post_title: "T",
			post_url: null,
			post_published: null,
		});
	});
});
