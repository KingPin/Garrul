/**
 * Textual parse of the `Bindings` type in src/index.ts.
 *
 * `Bindings` stays hand-written — it carries the doc comments explaining each
 * setting, which a generated type would lose — and it is a *type*, so there is
 * no runtime form to import. Everything that needs the binding list therefore
 * parses the source: `scripts/upgrade/build-manifest.ts` (release-manifest.json
 * KV/D1/Analytics entries, plus the registry parity assertion) and
 * `scripts/build-config.ts` (the `[[d1_databases]]`, `[[kv_namespaces]]` and
 * `[[analytics_engine_datasets]]` blocks in wrangler.example.toml, and the
 * `create_d1` / `create_kv` call lists in setup.sh).
 *
 * It lives here rather than in either consumer because it had already been
 * written twice — once in build-manifest.ts and once again in
 * tests/config-registry.test.ts, whose copy was commented "same textual parse
 * build-manifest.ts performs". Two parsers that must agree is the same drift
 * class the config registry exists to kill.
 *
 * Note this is deliberately *not* part of `CONFIG_REGISTRY`: that array covers
 * environment names (`string`-typed fields) and is asserted to match them
 * exactly, so folding `KVNamespace` fields into it would break
 * `assertRegistryMatchesBindings`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type DerivedBindings = {
	d1: { binding: string; databaseName: string }[];
	kv: string[];
	analytics: { binding: string; dataset: string }[];
	/** Every `string`-typed field, secret or var — classified by the registry. */
	strings: string[];
};

const ANALYTICS_DATASET = "garrul_events";

/** Reads the source that `parseBindings` expects. */
export const readBindingsSource = (repoRoot: string): string =>
	readFileSync(join(repoRoot, "src", "index.ts"), "utf8");

/**
 * Pure so callers can feed it a fixture instead of the real file — a
 * hypothetical binding is how the generators get tested without editing
 * src/index.ts.
 */
export const parseBindings = (src: string): DerivedBindings => {
	const start = src.indexOf("export type Bindings");
	if (start < 0) {
		throw new Error("could not locate `export type Bindings` in src/index.ts");
	}
	const open = src.indexOf("{", start);
	const close = src.indexOf("};", open);
	if (open < 0 || close < 0) {
		throw new Error("could not find Bindings block braces");
	}
	const body = src.slice(open + 1, close);
	const lines = body
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("//"));

	const out: DerivedBindings = { d1: [], kv: [], analytics: [], strings: [] };

	for (const line of lines) {
		const match = /^([A-Z_][A-Z0-9_]*)\??:\s*([^;]+);?$/.exec(line);
		if (!match) continue;
		const name = match[1] as string;
		const type = (match[2] as string).trim();

		if (type === "D1Database") {
			out.d1.push({
				binding: name,
				databaseName: name === "DB" ? "garrul-db" : name.toLowerCase(),
			});
		} else if (type === "KVNamespace") {
			out.kv.push(name);
		} else if (type === "AnalyticsEngineDataset") {
			out.analytics.push({ binding: name, dataset: ANALYTICS_DATASET });
		} else if (type === "string") {
			out.strings.push(name);
		}
	}

	return out;
};
