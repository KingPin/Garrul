/**
 * Pluggable content-classifier dispatch. Mirrors src/lib/email.ts:
 *   - SPAM_PROVIDER selects the implementation ("akismet" | "workers-ai" | "decisions").
 *   - When unset, this returns `null` ("no opinion") and the caller falls
 *     back to whatever the in-core heuristics decided.
 *   - Adapters that fail transiently also return `null` rather than throwing;
 *     a spam check should never break comment posting.
 *
 * A non-null `{ spam: true }` verdict flips the eventual `insertComment`
 * status to `'pending'`. Verdicts are never silently discarded.
 */

import { log } from "../log";
import { checkAkismet } from "./akismet";
import { checkDecisions, DEFAULT_DECISIONS_URL } from "./decisions";
import { checkWorkersAi, type ClefModel } from "./workers-ai";

export type SpamCheckInput = {
	body_md: string;
	author_name: string;
	author_email?: string | null;
	user_agent: string | null;
	post_url: string | null;
	is_first_comment: boolean;
};

export type SpamVerdict = {
	spam: boolean;
	reason?: string;
	// Persisted to spam_verdicts.score / spam_verdicts.raw when present. Both
	// optional because in-core heuristics often have no meaningful score and
	// not every adapter exposes raw provider output.
	score?: number | null;
	raw?: Record<string, unknown> | null;
};

export type SpamEnv = {
	SPAM_PROVIDER?: string;
	AKISMET_API_KEY?: string;
	AKISMET_SITE_URL?: string;
	SPAM_DECISIONS_URL?: string;
	SPAM_DECISIONS_API_KEY?: string;
	AI?: Ai;
};

export const checkSpam = async (
	env: SpamEnv,
	input: SpamCheckInput,
	// The resolved `spam_ai_threshold` setting; 70 mirrors its default.
	aiThreshold = 70,
	// The resolved `spam_ai_model` setting; clef-flash mirrors its default.
	aiModel: ClefModel = "clef-flash",
	// The resolved `spam_decisions_model` setting; empty mirrors its default
	// and skips the check.
	decisionsModel = "",
): Promise<SpamVerdict | null> => {
	const provider = env.SPAM_PROVIDER;
	if (!provider) return null;
	if (provider === "akismet") {
		if (!env.AKISMET_API_KEY || !env.AKISMET_SITE_URL) return null;
		return checkAkismet(
			{ apiKey: env.AKISMET_API_KEY, siteUrl: env.AKISMET_SITE_URL },
			input,
		);
	}
	if (provider === "workers-ai") {
		if (!env.AI) return null;
		return checkWorkersAi(
			{ ai: env.AI, model: aiModel, threshold: aiThreshold },
			input,
		);
	}
	if (provider === "decisions") {
		if (!env.SPAM_DECISIONS_API_KEY || !decisionsModel) return null;
		const url = env.SPAM_DECISIONS_URL || DEFAULT_DECISIONS_URL;
		// The key rides in a header; never send it over plaintext.
		if (!url.startsWith("https://")) {
			log.warn("spam.adapter.misconfigured", {
				provider,
				reason: "url_not_https",
			});
			return null;
		}
		return checkDecisions(
			{
				url,
				apiKey: env.SPAM_DECISIONS_API_KEY,
				model: decisionsModel,
				threshold: aiThreshold,
			},
			input,
		);
	}
	log.warn("spam.adapter.unknown_provider", { provider });
	return null;
};
