/**
 * Cloudflare Workers AI classifier, backed by Clef-flash or Clef.
 *
 * Privacy posture: nothing leaves the Cloudflare edge — the AI binding
 * routes the inference call internally. Operators concerned about shipping
 * comment bodies to a third party (Akismet) should prefer this provider.
 *
 * The question, the state and the threshold rule are shared with every
 * decision-model provider (./decision.ts). The spam/ham cut-off is the
 * `spam_ai_threshold` setting, editable on /admin/settings.
 *
 * No verdict cache: a call costs a few neurons, a hit needs the same body
 * twice, and a key on the body alone would hand one author's verdict to
 * another, since the model also sees the author, page and first-comment flag.
 */

import { log } from "../log";
import {
	decisionState,
	decisionVerdict,
	QUESTIONS,
	spamProbability,
} from "./decision";
import type { SpamCheckInput, SpamVerdict } from "./index";

// The two text-capable Clef sizes. Both take the same request; they differ
// in size, speed and price (docs/ANTISPAM.md has the figures). Clef-omni is
// left out: it adds audio and video input, and a comment is text.
export const CLEF_MODELS = ["clef-flash", "clef"] as const;
export type ClefModel = (typeof CLEF_MODELS)[number];

type WorkersAiConfig = {
	ai: Ai;
	model: ClefModel;
	// Percent, 1–100: flag when P(spam) >= this / 100.
	threshold: number;
};

// The installed workers-types predates Clef, so `Ai.run`'s model-keyed
// overloads don't know this id. Call it through a plain signature instead.
type ClefRunner = {
	run(model: string, input: unknown): Promise<unknown>;
};

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

export const checkWorkersAi = async (
	cfg: WorkersAiConfig,
	input: SpamCheckInput,
): Promise<SpamVerdict | null> => {
	try {
		const id = `@cf/cloudflare/${cfg.model}`;
		const out = await withTimeout(
			(cfg.ai as unknown as ClefRunner).run(id, {
				model: cfg.model,
				state: decisionState(input),
				questions: QUESTIONS,
			}),
			TIMEOUT_MS,
		);
		const p = spamProbability(out);
		if (p === null) {
			log.warn("spam.adapter.error", {
				provider: "workers-ai",
				unexpected_response: true,
			});
			return null;
		}
		return decisionVerdict(p, cfg.threshold, "workers-ai", id);
	} catch (err) {
		log.warn("spam.adapter.error", {
			provider: "workers-ai",
			error: String(err),
		});
		return null;
	}
};
