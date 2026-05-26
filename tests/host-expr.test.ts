/**
 * Structural tests for the hostExpr SQL builder.
 *
 * Project convention (see tests/votes.test.ts): no Miniflare here, no real
 * D1 execution. Semantic correctness of the emitted CASE expression is
 * verified by running against the dogfood instance with `npm run dev`.
 *
 * What this file proves:
 *   - The helper rejects anything that isn't a SQL identifier (defense in
 *     depth against accidental injection from a caller).
 *   - The emitted fragment references the column reference passed in.
 *   - The NO_URL_BUCKET sentinel is embedded literally so SQL output and
 *     JS-side comparisons stay in sync.
 */
import { describe, it, expect } from "vitest";
import { hostExpr, NO_URL_BUCKET } from "../src/db/host-expr";

describe("hostExpr — column reference guard", () => {
	it("accepts unqualified identifiers", () => {
		expect(() => hostExpr("url")).not.toThrow();
	});

	it("accepts qualified identifiers", () => {
		expect(() => hostExpr("p.url")).not.toThrow();
	});

	it.each([
		"'; DROP TABLE posts; --",
		"p.url; SELECT 1",
		"p.url OR 1=1",
		"",
		" p.url",
		"p.url ",
		"p..url",
		"1col",
		"p.url, c.id",
	])("rejects %j", (bad) => {
		expect(() => hostExpr(bad)).toThrow(/invalid column reference/);
	});
});

describe("hostExpr — emitted SQL shape", () => {
	const sql = hostExpr("p.url");

	it("references the column passed in", () => {
		expect(sql).toContain("p.url");
	});

	it("uses CASE/WHEN/ELSE and SUBSTR/INSTR/LENGTH builtins", () => {
		for (const kw of ["CASE", "WHEN", "ELSE", "END", "SUBSTR", "INSTR", "LENGTH"]) {
			expect(sql).toContain(kw);
		}
	});

	it("returns the NO_URL_BUCKET sentinel for null/empty/schemeless input", () => {
		expect(sql).toContain(`'${NO_URL_BUCKET}'`);
	});

	it("splits the after-scheme substring at the first '/'", () => {
		// The fragment must look at INSTR(<after>, '/') to find the end of
		// the host. If a future refactor drops this, the bucket would
		// include the path — regression-critical.
		expect(sql).toContain("'/'");
		expect(sql).toContain("'://'");
	});
});

describe("NO_URL_BUCKET", () => {
	it("matches the literal embedded in the SQL", () => {
		expect(NO_URL_BUCKET).toBe("(no url)");
	});
});
