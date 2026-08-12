/**
 * Guards the CSS minification step in scripts/build-styles.ts.
 *
 * The widget's entire visual surface is one stylesheet that now passes through
 * a minifier on the way into the bundle. A minifier that silently dropped a
 * rule would produce a green build and a visibly broken widget, so this asserts
 * that the things the widget and its operators actually depend on — the public
 * theming variables, the private ones they chain through, and every class the
 * renderer attaches — survive the transform.
 *
 * It reads the generated file rather than importing it so the failure when
 * build:assets hasn't run is a legible message instead of a resolution error.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src/widget/styles.css");
const GEN = join(ROOT, "src/widget/styles.gen.ts");

const source = readFileSync(SRC, "utf8");

if (!existsSync(GEN)) {
	throw new Error(
		`${GEN} is missing — run \`npm run build:styles\` (or \`npm run build:assets\`) first.`,
	);
}
const generated = readFileSync(GEN, "utf8");

/** The minified CSS, back out of the JS string literal it was written into. */
const minified: string = (() => {
	const m = generated.match(/export const STYLE_CSS: string = (".*");\n$/s);
	if (!m?.[1]) throw new Error("styles.gen.ts is not in the expected shape");
	return JSON.parse(m[1]) as string;
})();

/** Unique matches of `re` (capture group 1) across the source stylesheet. */
const collect = (re: RegExp): string[] => [
	...new Set([...source.matchAll(re)].map((m) => m[1] as string)),
];

describe("widget stylesheet minification", () => {
	it("preserves every public --garrul-* theming variable", () => {
		// docs/THEMING.md makes these a semver-protected contract; an operator's
		// override targets them by name, so a rename or drop is a breaking change.
		const publicVars = collect(/(--garrul-[a-z0-9-]+)/g);
		expect(publicVars.length).toBeGreaterThan(0);
		for (const v of publicVars) expect(minified).toContain(v);
	});

	it("preserves every private --gr-* theming variable", () => {
		const privateVars = collect(/(--gr-[a-z0-9-]+)/g);
		expect(privateVars.length).toBeGreaterThan(0);
		for (const v of privateVars) expect(minified).toContain(v);
	});

	it("preserves every .gr-* class selector the renderer attaches", () => {
		const classes = collect(/\.(gr-[a-z0-9-]+)/g);
		expect(classes.length).toBeGreaterThan(0);
		for (const c of classes) expect(minified).toContain(c);
	});

	it("preserves the shadow-root and dark-mode entry points", () => {
		// :host is what scopes the whole sheet; losing it leaks styles nowhere.
		expect(minified).toContain(":host");
		expect(minified).toContain("prefers-color-scheme");
	});

	it("actually minifies rather than only stripping comments", () => {
		expect(minified).not.toContain("/*");
		// esbuild drops comments even with minify off, so comment-freeness alone
		// does not prove the minifier ran. Collapsed whitespace does: the source
		// is tab-indented, one declaration per line, and the minified form is
		// essentially a single line. Measured at the time of writing: 0.607 of
		// source minified vs 0.707 with `minify: false`.
		expect(minified).not.toContain("\t");
		expect((minified.match(/\n/g) ?? []).length).toBeLessThan(5);
		expect(minified.length).toBeLessThan(source.length * 0.65);
	});

	it("emits no stray template-literal terminators", () => {
		// The CSS used to live in a template literal in embed.ts. It is a plain
		// JSON string now, but a backtick or ${ sneaking in would have been a
		// build break then and is worth keeping an eye on.
		expect(minified).not.toContain("`");
		expect(minified).not.toContain("${");
	});
});
