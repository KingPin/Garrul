/**
 * The lazy highlighter loader (src/widget/code-highlight.ts).
 *
 * Node has no DOM, so document, window and the block elements are minimal
 * stubs. Each test re-imports the module because its state is per page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Fn = (code: string, lang: string) => string | null;
type Script = { src?: string; onload?: () => void; onerror?: () => void };
type Block = {
	textContent: string;
	className: string;
	isConnected: boolean;
	html?: string;
	replaceChildren(x: string): void;
};

const block = (text: string, lang = "js"): Block => {
	const b: Block = {
		textContent: text,
		className: `language-${lang}`,
		isConnected: true,
		replaceChildren: (x) => {
			b.html = x;
		},
	};
	return b;
};
const root = (blocks: Block[]) => ({ querySelectorAll: () => blocks }) as unknown as ParentNode;
const settle = () => new Promise((r) => setTimeout(r, 20));

let scripts: Script[];
let win: { __garrulHighlight?: Fn };

beforeEach(() => {
	vi.resetModules();
	scripts = [];
	win = {};
	vi.stubGlobal("__GARRUL_HL_HASH__", "h1");
	vi.stubGlobal("window", win);
	vi.stubGlobal("document", {
		createElement: () => ({}),
		head: { appendChild: (s: Script) => scripts.push(s) },
		createRange: () => ({ createContextualFragment: (html: string) => `frag:${html}` }),
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const load = () => import("../src/widget/code-highlight");

describe("code-highlight loader", () => {
	it("loads nothing when the flag is off", async () => {
		const m = await load();
		m.setCodeHighlight(null);
		m.highlightCode(root([block("x")]));
		expect(scripts).toHaveLength(0);
	});

	it("loads nothing when every block is over the cap", async () => {
		const m = await load();
		m.setCodeHighlight("https://c.example");
		m.highlightCode(root([block("x".repeat(m.MAX_CODE_CHARS + 1))]));
		expect(scripts).toHaveLength(0);
	});

	it("loads one script for many blocks and replaces each block once", async () => {
		const m = await load();
		m.setCodeHighlight("https://c.example");
		const a = block("a");
		const b = block("b", "py");
		m.highlightCode(root([a]));
		m.highlightCode(root([a, b]));
		expect(scripts).toHaveLength(1);
		expect(scripts[0]?.src).toBe("https://c.example/embed-highlight.js?h=h1");
		const fn = vi.fn<Fn>((code, lang) => `<${lang}>${code}`);
		win.__garrulHighlight = fn;
		scripts[0]?.onload?.();
		await settle();
		expect(a.html).toBe("frag:<js>a");
		expect(b.html).toBe("frag:<py>b");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("keeps blocks plain when the script fails, and never retries", async () => {
		const m = await load();
		m.setCodeHighlight("https://c.example");
		const a = block("a");
		m.highlightCode(root([a]));
		scripts[0]?.onerror?.();
		await settle();
		expect(a.html).toBeUndefined();
		m.highlightCode(root([block("b")]));
		expect(scripts).toHaveLength(1);
	});

	it("keeps a block plain when highlighting throws and goes on", async () => {
		const m = await load();
		m.setCodeHighlight("https://c.example");
		const bad = block("bad");
		const good = block("good");
		m.highlightCode(root([bad, good]));
		win.__garrulHighlight = (code) => {
			if (code === "bad") throw new Error("boom");
			return code;
		};
		scripts[0]?.onload?.();
		await settle();
		expect(bad.html).toBeUndefined();
		expect(good.html).toBe("frag:good");
	});

	it("stops highlighting once the page time budget is spent", async () => {
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		const m = await load();
		m.setCodeHighlight("https://c.example");
		const a = block("a");
		const b = block("b");
		m.highlightCode(root([a, b]));
		win.__garrulHighlight = (code) => {
			clock += 250;
			return code;
		};
		scripts[0]?.onload?.();
		await settle();
		expect(a.html).toBe("frag:a");
		expect(b.html).toBeUndefined();
	});

	it("skips blocks detached while loading without spending the budget", async () => {
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		const m = await load();
		m.setCodeHighlight("https://c.example");
		const old = block("old");
		const fresh = block("fresh");
		m.highlightCode(root([old]));
		old.isConnected = false;
		m.highlightCode(root([fresh]));
		const fn = vi.fn<Fn>((code) => {
			clock += 150;
			return code;
		});
		win.__garrulHighlight = fn;
		scripts[0]?.onload?.();
		await settle();
		expect(old.html).toBeUndefined();
		expect(fresh.html).toBe("frag:fresh");
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
