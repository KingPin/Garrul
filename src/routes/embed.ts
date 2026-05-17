/**
 * GET /embed.js — serves the bundled widget.
 *
 * The bundle is built by scripts/build-embed.ts which:
 *   1. esbuild bundles src/widget/embed.ts → dist/embed.js
 *   2. Re-emits the same bytes as src/widget/embed.bundled.ts (a const
 *      string export) so this route imports them as a normal module —
 *      no wrangler text-loader rule required of self-hosters.
 *
 * Cache: 1 hour browser, 1 day edge. The bundle changes only on deploy,
 * so the edge TTL is safe; we trade some hot-deploy lag for fewer Worker
 * invocations from cached embeds.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { EMBED_JS } from "../widget/embed.bundled";

const embed = new Hono<{ Bindings: Bindings }>();

embed.get("/embed.js", (c) => {
	c.header("content-type", "application/javascript; charset=utf-8");
	c.header("cache-control", "public, max-age=3600, s-maxage=86400");
	c.header("x-content-type-options", "nosniff");
	return c.body(EMBED_JS);
});

export { embed };
