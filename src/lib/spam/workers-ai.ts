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
 * We cache the probability in KV (RATE_LIMITS namespace) keyed on a short
 * hash of body_md so identical resubmissions don't re-bill.
 */

import { log } from "../log";
import type { SpamCheckInput, SpamVerdict } from "./index";

type WorkersAiConfig = {
	ai: Ai;
	cache: KVNamespace | null;
	// Percent, 1–100: flag when P(spam) * 100 >= this.
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

const encoder = new TextEncoder();

const cacheKey = async (bodyMd: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(bodyMd));
	const hex = Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	return `spamcache:${hex.slice(0, 32)}`;
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
	const spam = p * 100 >= threshold;
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
	const key = await cacheKey(input.body_md);
	if (cfg.cache) {
		// Pre-Clef entries hold "spam"/"ham"; they parse to NaN and fall
		// through to a fresh call. A miss is null, which Number() would turn
		// into 0 — a confident "ham" — so it is screened out first.
		const hit = await cfg.cache.get(key);
		const cached = hit === null ? Number.NaN : Number(hit);
		if (isProbability(cached)) return verdict(cached, cfg.threshold, true);
	}

	try {
		// biome-ignore lint/suspicious/noExplicitAny: the response is probed defensively below.
		const out: any = await (cfg.ai as unknown as ClefRunner).run(MODEL, {
			model: "clef-flash",
			state: {
				author: input.author_name,
				first_time_commenter: input.is_first_comment,
				page: input.post_url,
				comment: input.body_md.slice(0, MAX_BODY_FOR_PROMPT),
			},
			questions: QUESTIONS,
		});
		const p = out?.answers?.spam?.noul;
		if (!isProbability(p)) {
			log.warn("spam.adapter.error", {
				provider: "workers-ai",
				unexpected_response: true,
			});
			return null;
		}
		if (cfg.cache) {
			await cfg.cache.put(key, String(p), {
				expirationTtl: CACHE_TTL_SECONDS,
			});
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
