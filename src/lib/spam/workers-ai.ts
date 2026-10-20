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
 * `spam_ai_threshold` setting, editable on /admin/settings.
 *
 * No verdict cache: a call costs a few neurons, a hit needs the same body
 * twice, and a key on the body alone would hand one author's verdict to
 * another, since the model also sees the author, page and first-comment flag.
 */

import { log } from "../log";
import type { SpamCheckInput, SpamVerdict } from "./index";

type WorkersAiConfig = {
	ai: Ai;
	// Percent, 1–100: flag when P(spam) >= this / 100.
	threshold: number;
};

// The installed workers-types predates Clef, so `Ai.run`'s model-keyed
// overloads don't know this id. Call it through a plain signature instead.
type ClefRunner = {
	run(model: string, input: unknown): Promise<unknown>;
};

const MODEL = "@cf/cloudflare/clef-flash";
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

const verdict = (p: number, threshold: number): SpamVerdict => {
	// Divide the threshold, never multiply p: 0.57 * 100 is 56.99999999999999,
	// which would pass a score sitting exactly on the cut-off as ham.
	const spam = p >= threshold / 100;
	const raw = { model: MODEL, threshold };
	return spam
		? { spam, reason: "workers-ai.spam", score: p, raw }
		: { spam, score: p, raw };
};

export const checkWorkersAi = async (
	cfg: WorkersAiConfig,
	input: SpamCheckInput,
): Promise<SpamVerdict | null> => {
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
		return verdict(p, cfg.threshold);
	} catch (err) {
		log.warn("spam.adapter.error", {
			provider: "workers-ai",
			error: String(err),
		});
		return null;
	}
};
