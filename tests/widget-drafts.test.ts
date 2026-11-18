/**
 * Draft keys carry the Worker origin so two pages on the same host origin
 * that point at different Workers (staging and production during a
 * migration, say) cannot restore each other's text. Legacy keys (no origin)
 * are adopted once so an upgrade does not lose a half-typed comment.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { draftKey, draftSaver, legacyDraftKey, adoptLegacyDraft } from "../src/widget/drafts";

const fakeStorage = (init: Record<string, string> = {}) => {
	const m = new Map(Object.entries(init));
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		dump: () => Object.fromEntries(m),
	};
};

describe("draftKey", () => {
	it("includes origin, slug and optional parent", () => {
		expect(draftKey("https://c.example", "post", null)).toBe("garrul:draft:https://c.example:post");
		expect(draftKey("https://c.example", "post", "01H")).toBe(
			"garrul:draft:https://c.example:post:01H",
		);
	});

	it("differs across origins for the same slug", () => {
		expect(draftKey("https://a.example", "post", null)).not.toBe(
			draftKey("https://b.example", "post", null),
		);
	});

	it("legacyDraftKey reproduces the pre-2.27.0 key", () => {
		expect(legacyDraftKey("post", null)).toBe("garrul:draft:post");
		expect(legacyDraftKey("post", "01H")).toBe("garrul:draft:post:01H");
	});
});

describe("adoptLegacyDraft", () => {
	it("moves a legacy draft into the new key when the new key is empty", () => {
		const s = fakeStorage({ "garrul:draft:post": "hello" });
		adoptLegacyDraft(s, "garrul:draft:https://c.example:post", "garrul:draft:post");
		expect(s.dump()).toEqual({ "garrul:draft:https://c.example:post": "hello" });
	});

	it("leaves an existing new-key draft alone", () => {
		const s = fakeStorage({
			"garrul:draft:post": "old",
			"garrul:draft:https://c.example:post": "new",
		});
		adoptLegacyDraft(s, "garrul:draft:https://c.example:post", "garrul:draft:post");
		expect(s.dump()).toEqual({
			"garrul:draft:post": "old",
			"garrul:draft:https://c.example:post": "new",
		});
	});

	it("does nothing when there is no legacy draft", () => {
		const s = fakeStorage();
		adoptLegacyDraft(s, "garrul:draft:https://c.example:post", "garrul:draft:post");
		expect(s.dump()).toEqual({});
	});

	it("swallows storage errors", () => {
		const throwing = {
			getItem: () => {
				throw new Error("disabled");
			},
			setItem: () => {},
			removeItem: () => {},
		};
		expect(() => adoptLegacyDraft(throwing, "a", "b")).not.toThrow();
	});
});

describe("draftSaver", () => {
	afterEach(() => vi.useRealTimers());

	const setup = () => {
		vi.useFakeTimers();
		const store = fakeStorage();
		let value = "";
		const saver = draftSaver(() => store, "k", () => value);
		const type = (v: string): void => {
			value = v;
			saver.schedule();
		};
		return { store, saver, type };
	};

	it("saves only after the debounce", () => {
		const { store, type } = setup();
		type("hel");
		type("hello");
		vi.advanceTimersByTime(399);
		expect(store.dump()).toEqual({});
		vi.advanceTimersByTime(1);
		expect(store.dump()).toEqual({ k: "hello" });
	});

	it("flush writes a pending value at once (Cancel, then reopen inside the window)", () => {
		const { store, saver, type } = setup();
		type("half a reply");
		saver.flush();
		expect(store.getItem("k")).toBe("half a reply");
		// The pending timer is gone, so it cannot overwrite a later draft.
		store.setItem("k", "typed in the reopened form");
		vi.advanceTimersByTime(1000);
		expect(store.getItem("k")).toBe("typed in the reopened form");
	});

	it("drop removes the draft and a pending save cannot bring it back", () => {
		const { store, saver, type } = setup();
		store.setItem("k", "older");
		type("posted text");
		saver.drop();
		vi.advanceTimersByTime(1000);
		expect(store.dump()).toEqual({});
	});

	it("an emptied field removes the draft", () => {
		const { store, saver, type } = setup();
		store.setItem("k", "older");
		type("");
		saver.flush();
		expect(store.dump()).toEqual({});
	});

	it("swallows storage errors, including a throwing getter", () => {
		vi.useFakeTimers();
		const saver = draftSaver(
			() => {
				throw new Error("blocked");
			},
			"k",
			() => "x",
		);
		expect(() => saver.flush()).not.toThrow();
		expect(() => saver.drop()).not.toThrow();
		saver.schedule();
		expect(() => vi.advanceTimersByTime(400)).not.toThrow();
	});
});
