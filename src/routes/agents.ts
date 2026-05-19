/**
 * GET /AGENTS.md — AI-targeted integration guide.
 *
 * The markdown content is bundled into src/agents.bundled.ts at build time
 * (see scripts/build-agents-md.ts). This handler substitutes two request-
 * time placeholders so the AI fetching the file gets ready-to-paste embed
 * snippets pointed at the actual instance:
 *
 *   {{INSTANCE_URL}}  → "https://<host>" (or env.CANONICAL_URL if set)
 *   {{INSTANCE_HOST}} → "<host>"
 *
 * No Origin gating — this is a public file, same exemption pattern as
 * GET /embed.js. Cached 5 minutes so re-deploys propagate quickly.
 *
 * GET /AGENTS-OPERATE.md returns 404 by design. The operator file is
 * repo-only.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { AGENTS_MD } from "../agents.bundled";

const agents = new Hono<{ Bindings: Bindings }>();

const FALLBACK_HOST = "your-garrul-host.example";

function resolveInstance(
	hostHeader: string | undefined,
	canonical: string | undefined,
): { url: string; host: string } {
	const trimmedCanonical = canonical?.trim();
	if (trimmedCanonical) {
		const stripped = trimmedCanonical.replace(/\/$/, "");
		try {
			return { url: stripped, host: new URL(stripped).host };
		} catch {
			// Malformed CANONICAL_URL — fall through to Host.
		}
	}
	const host =
		hostHeader && hostHeader.length > 0 ? hostHeader : FALLBACK_HOST;
	return { url: `https://${host}`, host };
}

agents.get("/AGENTS.md", (c) => {
	// In Workers the Host header is always set on the request; in some
	// test runtimes (e.g. undici's Request constructor) it isn't. Fall
	// back to the URL host so tests that build requests with
	// `new Request(url)` still get realistic templating.
	const hostHeader = c.req.header("host") ?? new URL(c.req.url).host;
	const { url, host } = resolveInstance(hostHeader, c.env.CANONICAL_URL);

	const body = AGENTS_MD.replaceAll("{{INSTANCE_URL}}", url).replaceAll(
		"{{INSTANCE_HOST}}",
		host,
	);

	const fmt = c.req.query("format");
	const contentType =
		fmt === "txt"
			? "text/plain; charset=utf-8"
			: "text/markdown; charset=utf-8";

	c.header("content-type", contentType);
	c.header("cache-control", "public, max-age=300");
	c.header("x-content-type-options", "nosniff");
	return c.body(body);
});

agents.get("/AGENTS-OPERATE.md", (c) => c.notFound());

export { agents };
