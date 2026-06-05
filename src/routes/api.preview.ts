/**
 * POST /api/v1/preview
 *   { body }  — render markdown to sanitized HTML without persisting.
 *
 * The widget's "Preview" tab posts the in-progress comment body here and
 * injects the returned HTML. Rendering server-side (rather than shipping a
 * markdown lib to the browser) guarantees the preview is byte-identical to
 * what a posted comment would store — same allowlist sanitizer, no XSS
 * divergence, no bundle bloat.
 *
 * No DB writes, no auth required (preview is harmless), but rate-limited on
 * the per-IP bucket so it can't be used as a free render/CPU faucet.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { renderMarkdown, validateBody } from "../lib/markdown";
import { clientIp, hashIp } from "../lib/ip-hash";
import { checkRateLimit } from "../lib/ratelimit";
import { t } from "../i18n";

const preview = new Hono<{ Bindings: Bindings }>();

type PreviewBody = { body?: string };

// Looser than the comment-post bucket: previewing is cheap and a user toggles
// the tab repeatedly while editing. Still bounded so it can't be abused.
const PREVIEW_LIMITS = {
	short: { max: 5, windowSec: 10 },
	long: { max: 60, windowSec: 600 },
};

preview.post("/", async (c) => {
	const body = await c.req.json<PreviewBody>().catch(() => null);
	if (!body) return c.json({ error: t("err.internal") }, 400);

	const valid = validateBody(body.body ?? "");
	if (!valid.ok) {
		const args = valid.max != null ? { max: valid.max } : undefined;
		return c.json({ error: t(valid.key, args) }, 400);
	}

	const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_HASH_SECRET);
	const rl = await checkRateLimit(c.env, ipHash, PREVIEW_LIMITS);
	if (!rl.ok) return c.json({ error: t("err.ratelimit") }, 429);

	const html = renderMarkdown(valid.body);
	return c.json({ html });
});

export { preview };
