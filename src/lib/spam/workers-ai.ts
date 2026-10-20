/**
 * Cloudflare Workers AI classifier, backed by Clef-flash.
 *
 * Privacy posture: nothing leaves the Cloudflare edge — the AI binding
 * routes the inference call internally. Operators concerned about shipping
 * comment bodies to a third party (Akismet) should prefer this provider.
 *
 * Clef is a decision model, not a chat model: it takes a state plus typed
 * questions and returns a probability per answer, so there is no free text
 * to parse and the verdict carries a real score. The spam/ham cut-off is the
 * `spam_ai_threshold` setting, applied here rather than baked into the cache,
 * so retuning it on /admin/settings also re-judges cached bodies.
 *
 * We cache the probability in the Cache API keyed on a short hash of
 * body_md so identical resubmissions don't re-bill. Not KV: an anonymous POST
 * reaches this, and KV's 1,000 writes/day are account-wide. The Cache API is
 * per-colo, so a resubmission through another colo re-bills; that is the
 * accepted cost.
 */

import { hexEncode } from "../hmac";
import { log } from "../log";
import { cacheKey, edgeCache } from "../response-cache";
import type { SpamCheckInput, SpamVerdict } from "./index";

type WorkersAiConfig = {
	ai: Ai;
	// The handling request's URL; the cache key must sit on the Worker's own
	// origin (see response-cache.ts). Null disables the cache.
	cacheUrl: string | null;
	// Percent, 1–100: flag when P(spam) >= this / 100.
	threshold: number;
};

// The installed workers-types predates Clef, so `Ai.run`'s model-keyed
// overloads don't know this id. Call it through a plain signature instead.
type ClefRunner = {
	run(model: string, input: unknown): Promise<unknown>;
};

const MODEL = "@cf/cloudflare/clef-flash";
const CACHE_TTL_SECONDS = 60 * 60 * 6; // 6h — body hash is content-addressed
const MAX_BODY_FOR_PROMPT = 2_000; // truncate for cost / latency
// The comment POST waits on this; past it the check is "no opinion". AI.run
// takes no AbortSignal, so the call is raced rather than cancelled.
const TIMEOUT_MS = 5_000;

const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			p,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};

const encoder = new TextEncoder();

const bodyHash = async (bodyMd: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(bodyMd));
	return hexEncode(digest).slice(0, 32);
};

const QUESTIONS = {
	spam: {
		type: "noul",
		instructions: "Is this blog comment spam?",
		criteria: {
			true: "SEO link farms, drug/casino/loan promos, paid backlink injections, gibberish or AI-generated promo, fake reviews with URLs.",
			false:
				"Genuine reactions, questions, disagreement or technical discussion, even if poorly written, short, off-topic or opinionated.",
		},
	},
};

const isProbability = (n: unknown): n is number =>
	typeof n === "number" && n >= 0 && n <= 1;

const verdict = (
	p: number,
	threshold: number,
	cached: boolean,
): SpamVerdict => {
	// Divide the threshold, never multiply p: 0.57 * 100 is 56.99999999999999,
	// which would pass a score sitting exactly on the cut-off as ham.
	const spam = p >= threshold / 100;
	const raw = { cached, model: MODEL, threshold };
	return spam
		? {
				spam,
				reason: cached ? "workers-ai.cached" : "workers-ai.spam",
				score: p,
				raw,
			}
		: { spam, score: p, raw };
};

export const checkWorkersAi = async (
	cfg: WorkersAiConfig,
	input: SpamCheckInput,
): Promise<SpamVerdict | null> => {
	const cache = cfg.cacheUrl ? edgeCache() : null;
	const key =
		cache && cfg.cacheUrl
			? cacheKey(cfg.cacheUrl, "spam-ai", { h: await bodyHash(input.body_md) })
			: null;
	if (cache && key) {
		// parseFloat, not Number(): Number("") is 0, a confident "ham".
		const hit = await cache.match(key).catch(() => undefined);
		const cached = hit ? Number.parseFloat(await hit.text()) : Number.NaN;
		if (isProbability(cached)) return verdict(cached, cfg.threshold, true);
	}

	try {
		// biome-ignore lint/suspicious/noExplicitAny: the response is probed defensively below.
		const out: any = await withTimeout(
			(cfg.ai as unknown as ClefRunner).run(MODEL, {
				model: "clef-flash",
				state: {
					author: input.author_name,
					first_time_commenter: input.is_first_comment,
					page: input.post_url,
					comment: input.body_md.slice(0, MAX_BODY_FOR_PROMPT),
				},
				questions: QUESTIONS,
			}),
			TIMEOUT_MS,
		);
		const p = out?.answers?.spam?.noul;
		if (!isProbability(p)) {
			log.warn("spam.adapter.error", {
				provider: "workers-ai",
				unexpected_response: true,
			});
			return null;
		}
		if (cache && key) {
			// Best-effort: a cache failure must not discard a good verdict.
			await cache
				.put(
					key,
					new Response(String(p), {
						headers: { "cache-control": `public, max-age=${CACHE_TTL_SECONDS}` },
					}),
				)
				.catch(() => {});
		}
		return verdict(p, cfg.threshold, false);
	} catch (err) {
		log.warn("spam.adapter.error", {
			provider: "workers-ai",
			error: String(err),
		});
		return null;
	}
};
