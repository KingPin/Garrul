/**
 * Composer textarea auto-sizing (src/widget/autosize.ts).
 *
 * Issue #52: the edit composer opened at the reply form's ~3-line min-height no
 * matter how long the comment was. These cover the sizing arithmetic and the two
 * ways it must stay out of the way: an unmeasurable textarea (not yet mounted,
 * or hidden behind the Preview tab) and one the author has resized by hand.
 */
import { describe, it, expect } from "vitest";
import {
	autoSizeTextarea,
	AUTOSIZE_MAX_VIEWPORT_FRACTION,
	type TextareaLike,
} from "../src/widget/autosize";

type FakeTextarea = TextareaLike & {
	style: { height: string };
	/** Simulate typing/deleting: changes what the content wants to measure. */
	setContent(px: number): void;
};

/**
 * Stand-in for a textarea. `scrollHeight` reports content height whenever the
 * inline height is `auto` or unset (what a real browser does — `auto` falls back
 * to the `rows` box, so longer content overflows and scrollHeight measures it)
 * and the larger of the two otherwise, which is what makes the module's
 * reset-before-measuring step observable. `chrome` is the border it must add
 * back on top of the padding-box scrollHeight.
 */
const fakeTextarea = (
	contentHeight: number,
	opts: {
		chrome?: number;
		isConnected?: boolean;
		hidden?: boolean;
		height?: string;
	} = {},
): FakeTextarea => {
	const chrome = opts.chrome ?? 2;
	const style = { height: opts.height ?? "" };
	let content = contentHeight;
	const unsized = (): boolean => style.height === "auto" || style.height === "";
	return {
		isConnected: opts.isConnected ?? true,
		hidden: opts.hidden ?? false,
		style,
		setContent(px: number) {
			content = px;
		},
		get scrollHeight() {
			return unsized()
				? content
				: Math.max(content, Number.parseFloat(style.height) - chrome);
		},
		get clientHeight() {
			return unsized() ? content : Number.parseFloat(style.height) - chrome;
		},
		get offsetHeight() {
			return this.clientHeight + chrome;
		},
	};
};

const VIEWPORT = 900;
const CAP = VIEWPORT * AUTOSIZE_MAX_VIEWPORT_FRACTION;

describe("autoSizeTextarea", () => {
	it("sizes a prefilled box to its content plus border", () => {
		const ta = fakeTextarea(320);
		autoSizeTextarea(ta, VIEWPORT);
		expect(ta.style.height).toBe("322px");
	});

	it("caps the height so the actions row stays on screen", () => {
		const ta = fakeTextarea(5000);
		autoSizeTextarea(ta, VIEWPORT);
		expect(ta.style.height).toBe(`${CAP}px`);
		expect(Number.parseFloat(ta.style.height)).toBeLessThan(VIEWPORT);
	});

	it("grows as content is added across successive calls", () => {
		const ta = fakeTextarea(100);
		autoSizeTextarea(ta, VIEWPORT);
		expect(ta.style.height).toBe("102px");
		ta.setContent(400);
		autoSizeTextarea(ta, VIEWPORT);
		expect(ta.style.height).toBe("402px");
	});

	it("shrinks again when content is deleted (the reset-before-measure step)", () => {
		// Without the `height: auto` reset, scrollHeight would keep reporting the
		// height set on the previous keystroke and the box would stay stuck tall.
		const ta = fakeTextarea(402);
		autoSizeTextarea(ta, VIEWPORT);
		expect(ta.style.height).toBe("404px");
		ta.setContent(48);
		autoSizeTextarea(ta, VIEWPORT);
		expect(ta.style.height).toBe("50px");
	});

	it("does nothing to a textarea that isn't in the DOM yet", () => {
		// buildForm() restores a draft before the form is inserted into the shadow
		// root; scrollHeight is 0 there and acting on it would collapse the box.
		const ta = fakeTextarea(320, { isConnected: false });
		autoSizeTextarea(ta, VIEWPORT);
		expect(ta.style.height).toBe("");
	});

	it("does nothing to a textarea hidden behind the Preview tab", () => {
		const ta = fakeTextarea(320, { hidden: true });
		autoSizeTextarea(ta, VIEWPORT);
		expect(ta.style.height).toBe("");
	});

	it("leaves a hand-resized textarea alone", () => {
		// The resize grip writes inline height too, so a height we never wrote is
		// the author's.
		const ta = fakeTextarea(320, { height: "700px" });
		autoSizeTextarea(ta, VIEWPORT);
		expect(ta.style.height).toBe("700px");
	});

	it("stops auto-sizing for good once a hand resize is seen", () => {
		const ta = fakeTextarea(120);
		autoSizeTextarea(ta, VIEWPORT);
		expect(ta.style.height).toBe("122px");

		// Author drags the grip down.
		ta.style.height = "600px";
		autoSizeTextarea(ta, VIEWPORT);
		expect(ta.style.height).toBe("600px");

		// Every later keystroke must keep its hands off, including ones whose
		// content would otherwise ask for a different height than last time.
		ta.setContent(900);
		autoSizeTextarea(ta, VIEWPORT);
		autoSizeTextarea(ta, VIEWPORT * 2);
		expect(ta.style.height).toBe("600px");
	});

	it("tracks manual resizes per element, not globally", () => {
		const resized = fakeTextarea(120, { height: "600px" });
		autoSizeTextarea(resized, VIEWPORT);
		const other = fakeTextarea(200);
		autoSizeTextarea(other, VIEWPORT);
		expect(other.style.height).toBe("202px");
	});

	it("scales the cap with the viewport", () => {
		const short = fakeTextarea(5000);
		autoSizeTextarea(short, 500);
		const tall = fakeTextarea(5000);
		autoSizeTextarea(tall, 1400);
		expect(Number.parseFloat(short.style.height)).toBeLessThan(
			Number.parseFloat(tall.style.height),
		);
	});

	it("always writes an integer pixel height", () => {
		const ta = fakeTextarea(5000);
		autoSizeTextarea(ta, 777);
		expect(ta.style.height).toMatch(/^\d+px$/);
	});
});
