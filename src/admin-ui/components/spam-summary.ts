import type { Bindings } from "../../index";
import type { ResolvedFlags, ResolvedNumbers } from "../../lib/settings";
import { escapeHtml } from "../escape";

export const spamSummary = (
	env: Bindings,
	flags: ResolvedFlags,
	numbers: ResolvedNumbers,
): string => {
	// Match the same gating evaluateSpam uses at runtime, otherwise the
	// dashboard would claim a layer is active when it isn't (honeypot timing
	// without SPAM_FORM_TS_SECRET, or a disabled link threshold).
	//
	// The three heuristic dials come from the resolved settings, not raw env, so
	// this line reflects an admin's Settings-page override rather than the
	// deploy-time value it replaced. The provider and its credentials stay env.
	const provider = env.SPAM_PROVIDER || "off";
	const heuristics: string[] = [];
	const minMs = numbers.spam_honeypot_min_ms;
	if (minMs > 0 && env.SPAM_FORM_TS_SECRET) {
		heuristics.push(`honeypot-timing(${minMs}ms)`);
	}
	const linkThreshold = numbers.spam_link_threshold;
	if (linkThreshold >= 0) {
		heuristics.push(`link-threshold(>${linkThreshold})`);
	}
	if (flags.spam_first_comment_moderate) {
		heuristics.push("first-comment-moderation");
	}
	const heuristicsLabel =
		heuristics.length > 0 ? heuristics.join(", ") : "none";
	return `provider=<code>${escapeHtml(provider)}</code> · heuristics=<code>${escapeHtml(heuristicsLabel)}</code>`;
};
