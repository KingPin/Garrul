/**
 * Pluggable content-classifier dispatch. Mirrors src/lib/email.ts:
 *   - SPAM_PROVIDER selects the implementation ("akismet" | "workers-ai").
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
import { checkWorkersAi } from "./workers-ai";

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
	AI?: Ai;
	RATE_LIMITS?: KVNamespace;
};

export const checkSpam = async (
	env: SpamEnv,
	input: SpamCheckInput,
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
			{ ai: env.AI, cache: env.RATE_LIMITS ?? null },
			input,
		);
	}
	log.warn("spam.adapter.unknown_provider", { provider });
	return null;
};
