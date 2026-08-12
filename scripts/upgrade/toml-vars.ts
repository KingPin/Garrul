/**
 * The `[vars]` table of a wrangler.toml, as names → values.
 *
 * Pure and dependency-free, deliberately. `npm run upgrade` runs *before*
 * `npm ci` on the target checkout, so nothing in the upgrade path may reach
 * for a TOML parser from node_modules. It also lives outside `wrangler.ts`
 * because that module is the subprocess seam every upgrade test `vi.mock`s
 * wholesale — a parser hidden behind that mock is a parser no test exercises,
 * and `build-manifest.ts` needs the same parse with no subprocesses in sight.
 */

/**
 * `null` marks a key that is set to something other than a plain
 * double-quoted string — a number, a bool, an array, a multi-line literal.
 * The key is still present (callers reporting "which settings are set" need
 * it); only the *value* is out of scope, because every caller here compares
 * against a string.
 */
export type TomlVars = Record<string, string | null>;

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * Values are read only far enough to recognise a single-line double-quoted
 * string. TOML's escape sequences are not decoded: every value this compares
 * against is a URL or an email address in a template file, and decoding \u
 * escapes would be more parser than the one job justifies.
 */
const stringValue = (rhs: string): string | null => {
	const m = /^"([^"\\]*)"\s*(?:#.*)?$/.exec(rhs.trim());
	return m ? (m[1] as string) : null;
};

/**
 * Walked line by line rather than matched with a lookahead: JS has no
 * end-of-string anchor that pairs with `^\[` under /m, and `\Z` is not one —
 * it parses as a literal "Z" and truncates a trailing table at the first
 * capital Z in a value.
 *
 * Only the top-level `[vars]` table is read. Environment-scoped tables
 * (`[env.production.vars]`) are deliberately skipped: matching them properly
 * needs real TOML, and every caller treats an absent key as "not set", which
 * is the quiet direction to be wrong in.
 *
 * Commented-out keys don't count as set.
 */
export const parseTomlVars = (raw: string): TomlVars => {
	const out: TomlVars = {};
	let inVars = false;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[")) {
			inVars = /^\[vars\]/.test(trimmed);
			continue;
		}
		if (!inVars || trimmed.startsWith("#")) continue;
		const m = KEY_RE.exec(trimmed);
		if (m) out[m[1] as string] = stringValue(m[2] as string);
	}
	return out;
};
