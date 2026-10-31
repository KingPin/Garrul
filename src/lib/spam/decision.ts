/**
 * The spam question shared by every decision-model provider.
 *
 * A decision model is not a chat model: it takes a state plus typed questions
 * and answers each with a probability, so there is no free text to parse and
 * the verdict carries a real score. Cloudflare's Clef (workers-ai.ts) and any
 * OpenAI-style /decisions endpoint (decisions.ts) take the same request and
 * return P(spam) under `answers.spam.noul`, so the question, the state Garrul
 * sends and the threshold rule live here once.
 */

import type { SpamCheckInput, SpamVerdict } from "./index";

const MAX_BODY_FOR_PROMPT = 2_000; // truncate for cost / latency

export const QUESTIONS = {
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

/**
 * What a decision model sees about a comment. No email, IP or user agent:
 * docs/ANTISPAM.md and docs/compliance/subprocessors.md promise exactly this
 * list, so widening it is a privacy change, not a tuning one.
 */
export const decisionState = (input: SpamCheckInput) => ({
	author: input.author_name,
	first_time_commenter: input.is_first_comment,
	page: input.post_url,
	comment: input.body_md.slice(0, MAX_BODY_FOR_PROMPT),
});

/** P(spam) from a decision response, or null when it is missing or not a probability. */
export const spamProbability = (out: unknown): number | null => {
	// biome-ignore lint/suspicious/noExplicitAny: the response is probed defensively.
	const p = (out as any)?.answers?.spam?.noul;
	return typeof p === "number" && p >= 0 && p <= 1 ? p : null;
};

export const decisionVerdict = (
	p: number,
	// Percent, 1–100: flag when P(spam) >= this / 100.
	threshold: number,
	provider: string,
	model: string,
): SpamVerdict => {
	// Divide the threshold, never multiply p: 0.57 * 100 is 56.99999999999999,
	// which would pass a score sitting exactly on the cut-off as ham.
	const spam = p >= threshold / 100;
	const raw = { model, threshold };
	return spam
		? { spam, reason: `${provider}.spam`, score: p, raw }
		: { spam, score: p, raw };
};
