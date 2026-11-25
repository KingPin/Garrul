/**
 * AA contrast guard for the code-highlight color tokens in styles.css.
 *
 * Every --gr-code-* default must reach 4.5:1 (WCAG 2.x AA, normal text)
 * against every surface of its own mode. Modes are decided by the enclosing
 * rule block (prefers-color-scheme: dark or data-theme="dark"), never by the
 * color's own luminance: a white token in a light block must not pass as dark.
 *
 * It parses the raw source, not the minified styles.gen.ts, so comments are
 * stripped here and the failure points at the rule that broke.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(ROOT, "src/widget/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
	selector: string;
	context: string;
	body: string;
	end: number;
}

/** Returns the value or throws with a message, so a missing anchor fails loudly. */
function required<T>(value: T | undefined, what: string): T {
	if (value === undefined) {
		throw new Error(`expected ${what} in styles.css; the scanner no longer finds it`);
	}
	return value;
}

/** A regex capture group that must exist. */
function group(m: RegExpMatchArray, i: number): string {
	return required(m[i], `capture group ${i} of ${m[0]}`);
}

/** Leaf rules (no nested braces) with the at-rule headers that enclose them. */
function leafRules(src: string): Rule[] {
	const out: Rule[] = [];
	const stack: { header: string; start: number }[] = [];
	let buf = "";
	for (let i = 0; i < src.length; i++) {
		const ch = src.charAt(i);
		if (ch === "{") {
			stack.push({ header: buf.trim(), start: i + 1 });
			buf = "";
		} else if (ch === "}") {
			const top = stack.pop();
			if (top) {
				const body = src.slice(top.start, i);
				if (!body.includes("{")) {
					const context = stack.map((s) => s.header).join(" ");
					out.push({ selector: top.header, context, body, end: i });
				}
			}
			buf = "";
		} else if (ch === ";") {
			buf = "";
		} else {
			buf += ch;
		}
	}
	return out;
}

const anchor = css.indexOf("* {");
if (anchor < 0) {
	throw new Error("the '* {' rule that ends the token section is gone; update the scanner");
}
const tokenSection = css.slice(0, anchor);
const rules = leafRules(tokenSection);
const isDark = (r: Rule) => /prefers-color-scheme:\s*dark|\[data-theme="dark"\]/.test(`${r.context} ${r.selector}`);

const CODE_NAMES = ["keyword", "string", "comment", "number", "title", "type", "attr", "tag"];

/** Each --gr-code-<name> declaration must be the chained, defaulted form. */
function codeDefaults(r: Rule): Map<string, string> {
	const found = new Map<string, string>();
	const decl = /--gr-code-([a-z]+):\s*var\(--garrul-code-([a-z]+),\s*(#[0-9a-fA-F]{6})\);/g;
	for (const m of r.body.matchAll(decl)) {
		expect(group(m, 1), "chain name must match").toBe(group(m, 2));
		found.set(group(m, 1), group(m, 3).toLowerCase());
	}
	const total = (r.body.match(/--gr-code-/g) ?? []).length;
	expect(total, `every --gr-code-* in ${r.selector} must be chained`).toBe(found.size);
	return found;
}

function surfaces(list: Rule[]): string[] {
	const set = new Set<string>();
	for (const r of list) {
		for (const m of r.body.matchAll(/--garrul-surface,\s*(#[0-9a-fA-F]{6})/g)) {
			set.add(group(m, 1).toLowerCase());
		}
	}
	return [...set];
}

function luminance(hex: string): number {
	const lin = (i: number) => {
		const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
}

function contrast(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	const hi = Math.max(la, lb);
	const lo = Math.min(la, lb);
	return (hi + 0.05) / (lo + 0.05);
}

const lightRules = rules.filter((r) => !isDark(r));
const darkRules = rules.filter(isDark);

const lightHost = required(
	lightRules.find((r) => r.selector === ":host"),
	"the light :host block",
);
const darkMedia = required(
	darkRules.find((r) => r.selector === ':host(:not([data-theme="light"]))'),
	"the prefers-color-scheme dark block",
);
const darkForced = required(
	darkRules.find((r) => r.selector === ':host([data-theme="dark"])'),
	"the data-theme dark block",
);

describe("code highlight color tokens", () => {
	it("defines exactly 8 code tokens in the light :host block and in both dark blocks", () => {
		for (const block of [lightHost, darkMedia, darkForced]) {
			const defaults = codeDefaults(block);
			expect([...defaults.keys()].sort()).toEqual([...CODE_NAMES].sort());
		}
	});

	it("finds the expected surfaces in each mode", () => {
		// Light: :host, soft and contrast presets. Dark: media default, soft and
		// contrast presets (inside the media query), plus the forced dark blocks.
		expect(surfaces(lightRules)).toHaveLength(3);
		expect(surfaces(darkRules)).toHaveLength(3);
	});

	it("uses only declared tokens in the hljs rules, and each token at least once", () => {
		const used = [...css.matchAll(/var\(--gr-code-([a-z]+)\)/g)].map((m) => group(m, 1));
		for (const name of used) {
			expect(CODE_NAMES, `var(--gr-code-${name}) is not a declared token`).toContain(name);
		}
		for (const name of CODE_NAMES) {
			expect(used, `--gr-code-${name} is never used`).toContain(name);
		}
	});

	it("keeps every light code default at 4.5:1 or better on every light surface", () => {
		const bgs = surfaces(lightRules);
		for (const [name, fg] of codeDefaults(lightHost)) {
			for (const bg of bgs) {
				expect(contrast(fg, bg), `light ${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it("keeps every dark code default at 4.5:1 or better on every dark surface", () => {
		const bgs = surfaces(darkRules);
		for (const block of [darkMedia, darkForced]) {
			for (const [name, fg] of codeDefaults(block)) {
				for (const bg of bgs) {
					expect(contrast(fg, bg), `dark ${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
				}
			}
		}
	});

	it("guards the contrast helper: white fails on light surfaces, black fails on dark", () => {
		for (const bg of surfaces(lightRules)) {
			expect(contrast("#ffffff", bg)).toBeLessThan(4.5);
		}
		for (const bg of surfaces(darkRules)) {
			expect(contrast("#000000", bg)).toBeLessThan(4.5);
		}
	});
});
