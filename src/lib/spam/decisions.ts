/**
 * Bring-your-own-key decision model: any endpoint that speaks the
 * OpenAI-style /decisions shape, OpenRouter's alpha route by default. It
 * sends the same question and state as the Workers AI classifier
 * (./decision.ts), so an operator can switch between the two and keep the
 * same threshold.
 *
 * Privacy posture: unlike workers-ai, the comment leaves Cloudflare. It goes
 * to whichever endpoint and model the operator configured — the same posture
 * as Akismet, and the operator must disclose it. Exactly `decisionState` is
 * sent: no email, IP or user agent.
 *
 * The key travels in the Authorization header, never the URL; the dispatcher
 * refuses a non-https endpoint, and a redirect is never followed. Logs carry
 * an HTTP status or an error's name, never a body or a message: an auth error
 * can quote the key back, and V8's JSON.parse error quotes a prefix of the
 * text it choked on — so scrubbing the full key out of a message would still
 * leak its start.
 *
 * `raw.model` records the model id the operator configured. With an alias
 * (`~vendor/model-latest`) that is the alias, not the concrete model behind it.
 */

import { log } from "../log";
import {
	decisionState,
	decisionVerdict,
	QUESTIONS,
	spamProbability,
} from "./decision";
import type { SpamCheckInput, SpamVerdict } from "./index";

// Alpha: the shape can change under us. A changed shape reads as a malformed
// answer, which is "no opinion" plus a log line, never a held comment.
export const DEFAULT_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

// The comment POST waits on this; past it the check is "no opinion".
const TIMEOUT_MS = 5_000;

type DecisionsConfig = {
	url: string;
	apiKey: string;
	model: string;
	// Percent, 1–100: flag when P(spam) >= this / 100.
	threshold: number;
};

export const checkDecisions = async (
	cfg: DecisionsConfig,
	input: SpamCheckInput,
): Promise<SpamVerdict | null> => {
	try {
		const res = await fetch(cfg.url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${cfg.apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: cfg.model,
				state: decisionState(input),
				questions: QUESTIONS,
			}),
			// Never follow a redirect: it could carry the Authorization header to
			// another host, or down to http://. A 3xx is not `ok`, so it lands in
			// the status branch below as no opinion.
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) {
			log.warn("spam.adapter.error", {
				provider: "decisions",
				status: res.status,
			});
			return null;
		}
		const p = spamProbability(await res.json());
		if (p === null) {
			log.warn("spam.adapter.error", {
				provider: "decisions",
				unexpected_response: true,
			});
			return null;
		}
		return decisionVerdict(p, cfg.threshold, "decisions", cfg.model);
	} catch (err) {
		// The name only (TimeoutError, SyntaxError, TypeError): a message can
		// quote the response body or the key. See the header.
		log.warn("spam.adapter.error", {
			provider: "decisions",
			error: err instanceof Error ? err.name : "unknown",
		});
		return null;
	}
};
