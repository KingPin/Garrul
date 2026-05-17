/**
 * Vitest config.
 *
 * Pure-logic units (sanitizer, ULID, rate-limit math, identicon) run in
 * the default node pool — they have no Workers-runtime deps and the node
 * pool starts ~10x faster than the Workers pool.
 *
 * When we add integration tests (M9+) that exercise D1/KV/Turnstile via
 * Hono routes, switch those test files to the `@cloudflare/vitest-pool-
 * workers` pool — keep this config as the fast lane for unit tests.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
		},
	},
});
