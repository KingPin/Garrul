/**
 * Telegram operator digest (Tier 4).
 *
 * Runs from the worker's `scheduled` export (see src/index.ts) alongside the
 * email digest and webhook-retry passes. The cron fires every 15 minutes, so
 * this function self-gates to roughly once per day via a bookkeeping row in
 * the `settings` table (`tg_digest_last_sent_at`). The drift (~the first
 * eligible tick after the interval elapses) is fine for an operator summary.
 *
 * Recipients are the linked operators who opted in (`telegram_links.digest`).
 * The link is identity-only — but the digest carries no per-action authority,
 * it's a read-only status summary, so we don't re-check roles here. (Banning,
 * approving, etc. from a button still re-checks the linked user's role.)
 *
 * The summary reuses the same admin-dashboard queries the slash commands use:
 * pending count, open reports + top flagged thread, 7-day spam rate, and the
 * oldest still-pending comment. No comment bodies, names, or emails are sent —
 * only counts, slugs, and ages — so this stays clear of the no-PII logging and
 * messaging conventions.
 */
import {
	adminOldestPending,
	adminOpenReportSummary,
	adminSpamRate,
	adminStats,
	getSetting,
	listTelegramDigestLinks,
	setSetting,
} from "../db/queries";
import { log } from "./log";
import { sendMessage } from "./telegram";

type DigestEnv = {
	DB: D1Database;
	TELEGRAM_BOT_TOKEN?: string;
	PUBLIC_BASE_URL?: string;
};

// settings key holding the epoch-ms of the last successful digest send.
const LAST_SENT_KEY = "tg_digest_last_sent_at";
// Fire at most once per ~day. Slightly under 24h so a digest that lands a few
// minutes late one day doesn't push the next one a full extra cron tick out.
const INTERVAL_MS = 23 * 3600 * 1000;

const escapeTg = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const relativeAge = (since: number, now: number): string => {
	const ms = Math.max(0, now - since);
	const mins = Math.floor(ms / 60000);
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h`;
	return `${Math.floor(hrs / 24)}d`;
};

const adminBase = (env: DigestEnv): string | null =>
	env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/$/, "") : null;

const renderDigest = async (env: DigestEnv, now: number): Promise<string> => {
	const [stats, reports, spam, oldest] = await Promise.all([
		adminStats(env.DB),
		adminOpenReportSummary(env.DB),
		adminSpamRate(env.DB, 7),
		adminOldestPending(env.DB),
	]);

	const base = adminBase(env);
	const pct =
		spam.total > 0 ? Math.round((spam.spam / spam.total) * 1000) / 10 : 0;

	const lines: string[] = ["<b>Garrul daily digest</b>"];

	lines.push(
		`• Pending: <b>${stats.pending_comments}</b>`,
		`• Open reports: <b>${reports.open}</b>${
			reports.top
				? ` — most on <code>${escapeTg(reports.top.slug)}</code> (${reports.top.count})`
				: ""
		}`,
		`• Spam (7d): <b>${pct}%</b> of ${spam.total}`,
		`• Banned users: <b>${stats.banned_users}</b>`,
	);

	if (oldest) {
		lines.push(`• Oldest pending: <b>${relativeAge(oldest.created_at, now)}</b> old`);
	}

	if (base) {
		lines.push("", `<a href="${escapeTg(`${base}/admin/queue`)}">Open moderation queue</a>`);
	}

	return lines.join("\n");
};

export const runTelegramDigest = async (
	env: DigestEnv,
	now: number = Date.now(),
): Promise<void> => {
	const token = env.TELEGRAM_BOT_TOKEN;
	if (!token) return;

	// Daily gate. A missing/garbage stored value reads as "never sent", so the
	// first eligible tick after a deploy sends one and stamps the clock.
	const last = Number(await getSetting(env.DB, LAST_SENT_KEY));
	if (Number.isFinite(last) && last > 0 && now - last < INTERVAL_MS) return;

	const recipients = await listTelegramDigestLinks(env.DB);
	// No opted-in operators: do nothing and DON'T stamp the clock, so the first
	// person to opt in gets a digest on the next tick rather than waiting a day.
	if (recipients.length === 0) return;

	const text = await renderDigest(env, now);

	let sent = 0;
	for (const link of recipients) {
		const res = await sendMessage(token, link.tg_chat_id, text);
		if (res.ok) sent++;
	}

	// Stamp the clock once we've attempted a send pass. Even a partial failure
	// counts — we don't want a single unreachable chat to re-trigger the whole
	// digest every 15 minutes for the operators it DID reach.
	await setSetting(env.DB, LAST_SENT_KEY, String(now));
	log.info("telegram.digest.sent", { recipients: recipients.length, sent });
};
