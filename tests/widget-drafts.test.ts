/**
 * Draft keys carry the Worker origin so two pages on the same host origin
 * that point at different Workers (staging and production during a
 * migration, say) cannot restore each other's text. Legacy keys (no origin)
 * are adopted once so an upgrade does not lose a half-typed comment.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
	adoptLegacyDraft,
	disposeAllDrafts,
	draftKey,
	draftSaver,
	draftStorage,
	flushAllDrafts,
	legacyDraftKey,
} from "../src/widget/drafts";

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

	it("dropIf removes a matching draft and cancels the timer", () => {
		const { store, saver, type } = setup();
		store.setItem("k", "posted text");
		type("posted text");
		saver.dropIf("posted text");
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
		saver.schedule();
		expect(() => saver.flush()).not.toThrow();
		expect(() => saver.dropIf("x")).not.toThrow();
		saver.schedule();
		expect(() => vi.advanceTimersByTime(400)).not.toThrow();
	});

	it("schedule after dispose writes nothing", () => {
		const { store, saver, type } = setup();
		saver.dispose();
		type("late");
		vi.advanceTimersByTime(1000);
		saver.flush();
		expect(store.dump()).toEqual({});
	});

	it("flush on a clean saver writes nothing", () => {
		vi.useFakeTimers();
		const store = fakeStorage({ k: "B" });
		const saver = draftSaver(() => store, "k", () => "");
		saver.flush();
		expect(store.dump()).toEqual({ k: "B" });
	});

	it("dropIf keeps a draft another tab changed", () => {
		const { store, saver, type } = setup();
		type("A");
		store.setItem("k", "B");
		saver.dropIf("A");
		vi.advanceTimersByTime(1000);
		expect(store.dump()).toEqual({ k: "B" });
	});

	it("dropIf removes its own obsolete save", () => {
		const { store, saver, type } = setup();
		type("hel");
		vi.advanceTimersByTime(400);
		expect(store.getItem("k")).toBe("hel");
		type("hello");
		saver.dropIf("hello");
		vi.advanceTimersByTime(1000);
		expect(store.dump()).toEqual({});
	});

	it("saver keeps saving after dropIf", () => {
		const { store, saver, type } = setup();
		type("hello");
		saver.dropIf("hello");
		type("next");
		vi.advanceTimersByTime(400);
		expect(store.dump()).toEqual({ k: "next" });
	});

	it("flushAllDrafts flushes but does not retire", () => {
		const { store, type } = setup();
		type("one");
		flushAllDrafts();
		expect(store.getItem("k")).toBe("one");
		type("two");
		vi.advanceTimersByTime(400);
		expect(store.getItem("k")).toBe("two");
	});

	it("disposeAllDrafts flushes once and retires every saver", () => {
		const { store, type } = setup();
		const w = vi.spyOn(store, "setItem");
		type("one");
		disposeAllDrafts();
		expect(w).toHaveBeenCalledTimes(1);
		type("two");
		vi.advanceTimersByTime(1000);
		flushAllDrafts();
		expect(store.getItem("k")).toBe("one");
	});
});

describe("draftStorage", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("falls back to memory when the getter throws", () => {
		vi.stubGlobal("localStorage", undefined);
		Object.defineProperty(globalThis, "localStorage", {
			get() {
				throw new Error("blocked");
			},
			configurable: true,
		});
		const s = draftStorage();
		s.setItem("g", "v");
		expect(s.getItem("g")).toBe("v");
		s.removeItem("g");
		expect(s.getItem("g")).toBeNull();
	});

	it("falls back to memory when setItem throws", () => {
		vi.useFakeTimers();
		const real = fakeStorage();
		vi.stubGlobal("localStorage", {
			...real,
			setItem: () => {
				throw new DOMException("full", "QuotaExceededError");
			},
		});
		const a = draftSaver(draftStorage, "q", () => "half a reply");
		a.schedule();
		a.flush(); // cancel
		// A rebuilt composer (new saver on the same key) restores the text.
		expect(draftStorage().getItem("q")).toBe("half a reply");
		draftStorage().removeItem("q");
		expect(draftStorage().getItem("q")).toBeNull();
		vi.useRealTimers();
	});
});
