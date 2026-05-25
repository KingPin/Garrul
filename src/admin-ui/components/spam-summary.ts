import type { Bindings } from "../../index";
import { escapeHtml } from "../escape";

export const spamSummary = (env: Bindings): string => {
	// Match the same gating evaluateSpam uses at runtime, otherwise the
	// dashboard would claim a layer is active when its value is invalid
	// (e.g. SPAM_LINK_THRESHOLD='NaN', SPAM_HONEYPOT_MIN_MS='0').
	const provider = env.SPAM_PROVIDER || "off";
	const heuristics: string[] = [];
	const minMs = Number.parseInt(env.SPAM_HONEYPOT_MIN_MS ?? "", 10);
	if (Number.isFinite(minMs) && minMs > 0 && env.SPAM_FORM_TS_SECRET) {
		heuristics.push(`honeypot-timing(${minMs}ms)`);
	}
	const linkThreshold = Number.parseInt(env.SPAM_LINK_THRESHOLD ?? "", 10);
	if (Number.isFinite(linkThreshold) && linkThreshold >= 0) {
		heuristics.push(`link-threshold(>${linkThreshold})`);
	}
	if (env.SPAM_FIRST_COMMENT_MODERATE === "true") {
		heuristics.push("first-comment-moderation");
	}
	const heuristicsLabel =
		heuristics.length > 0 ? heuristics.join(", ") : "none";
	return `provider=<code>${escapeHtml(provider)}</code> · heuristics=<code>${escapeHtml(heuristicsLabel)}</code>`;
};
