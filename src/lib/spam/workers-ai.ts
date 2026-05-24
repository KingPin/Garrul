/**
 * Cloudflare Workers AI classifier.
 *
 * Privacy posture: nothing leaves the Cloudflare edge — the AI binding
 * routes the inference call internally. Operators concerned about shipping
 * comment bodies to a third party (Akismet) should prefer this provider.
 *
 * Tradeoff: it's an LLM call, so it's slower and pricier per check than
 * Akismet. We cache verdicts in KV (RATE_LIMITS namespace) keyed on a
 * short hash of body_md so identical resubmissions don't re-bill.
 */

import { log } from "../log";
import type { SpamCheckInput, SpamVerdict } from "./index";

type WorkersAiConfig = {
	ai: Ai;
	cache: KVNamespace | null;
};

const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const CACHE_TTL_SECONDS = 60 * 60 * 6; // 6h — body hash is content-addressed
const MAX_BODY_FOR_PROMPT = 2_000; // truncate for cost / latency

const encoder = new TextEncoder();

const clipResponse = (s: string): string => s.slice(0, 60);

const cacheKey = async (bodyMd: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(bodyMd));
	const hex = Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	return `spamcache:${hex.slice(0, 32)}`;
};

const buildPrompt = (input: SpamCheckInput): string => {
	const body = input.body_md.slice(0, MAX_BODY_FOR_PROMPT);
	return [
		"You are a spam classifier for blog comments. Reply with exactly one word: SPAM or HAM.",
		"SPAM examples: SEO link farms, drug/casino/loan promos, paid backlink injections, gibberish or AI-generated promo, fake reviews with URLs.",
		"HAM examples: genuine reactions, questions, disagreement, technical discussion, even if poorly written.",
		"Borderline cases (off-topic but human, short, opinionated) are HAM.",
		"",
		`Author: ${input.author_name}`,
		`First-time commenter: ${input.is_first_comment ? "yes" : "no"}`,
		"Comment:",
		body,
		"",
		"Classification:",
	].join("\n");
};

export const checkWorkersAi = async (
	cfg: WorkersAiConfig,
	input: SpamCheckInput,
): Promise<SpamVerdict | null> => {
	const key = await cacheKey(input.body_md);
	if (cfg.cache) {
		const cached = await cfg.cache.get(key);
		if (cached === "spam")
			return {
				spam: true,
				reason: "workers-ai.cached",
				raw: { cached: true, model: MODEL },
			};
		if (cached === "ham")
			return { spam: false, raw: { cached: true, model: MODEL } };
	}

	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const out: any = await cfg.ai.run(MODEL, {
			messages: [
				{ role: "system", content: "You are a spam classifier. Reply SPAM or HAM only." },
				{ role: "user", content: buildPrompt(input) },
			],
			max_tokens: 4,
			temperature: 0,
		});
		const text =
			typeof out === "string"
				? out
				: typeof out?.response === "string"
					? out.response
					: "";
		const norm = text.trim().toUpperCase();
		const isSpam = norm.startsWith("SPAM");
		const isHam = norm.startsWith("HAM");
		if (!isSpam && !isHam) {
			log.warn("spam.adapter.error", {
				provider: "workers-ai",
				unexpected_response: text.slice(0, 60),
			});
			return null;
		}
		if (cfg.cache) {
			await cfg.cache.put(key, isSpam ? "spam" : "ham", {
				expirationTtl: CACHE_TTL_SECONDS,
			});
		}
		const raw = { cached: false, model: MODEL, response: clipResponse(norm) };
		return isSpam
			? { spam: true, reason: "workers-ai.spam", raw }
			: { spam: false, raw };
	} catch (err) {
		log.warn("spam.adapter.error", {
			provider: "workers-ai",
			error: String(err),
		});
		return null;
	}
};
