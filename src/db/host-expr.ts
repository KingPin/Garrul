/**
 * SQL expression helper for deriving the host bucket from a `posts.url`
 * column reference at query time.
 *
 * Single source of truth so filtering (WHERE), grouping (GROUP BY), and
 * projection (SELECT) all bucket comments identically across the admin UI.
 *
 * Read-side only: no schema change, no stored host column. Pre-1.0 design
 * decision; see docs/superpowers/specs/2026-05-26-domain-filtering-design.md.
 *
 * Semantics:
 *   - Full host including port (`example.com:8080` distinct from
 *     `example.com`). Matches what's actually in `posts.url`.
 *   - Case-sensitive as stored (no LOWER()). If real mixed-case duplicates
 *     show up, add lowercasing here in one place.
 *   - NULL, empty, or schemeless URLs → `NO_URL_BUCKET`.
 *
 * Security: `colRef` MUST be a code-literal column reference, never user
 * input. The runtime guard below rejects anything that's not a plain or
 * qualified SQL identifier.
 */

export const NO_URL_BUCKET = "(no url)";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

export const hostExpr = (colRef: string): string => {
	if (!IDENT.test(colRef)) {
		throw new Error(`hostExpr: invalid column reference ${JSON.stringify(colRef)}`);
	}
	// After-scheme substring: text following '://'.
	const after = `SUBSTR(${colRef}, INSTR(${colRef}, '://') + 3)`;
	return `CASE
		WHEN ${colRef} IS NULL OR ${colRef} = '' OR INSTR(${colRef}, '://') = 0 THEN '${NO_URL_BUCKET}'
		ELSE SUBSTR(
			${after},
			1,
			CASE
				WHEN INSTR(${after}, '/') > 0 THEN INSTR(${after}, '/') - 1
				ELSE LENGTH(${after})
			END
		)
	END`;
};
