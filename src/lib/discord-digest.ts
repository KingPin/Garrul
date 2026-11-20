/**
 * Daily operator digest posted to one Discord channel.
 *
 * Same data as the Telegram digest (collectDigest), its own gate and its own
 * last-sent key. The cron calls this every tick; it self-gates to about once
 * a day through `dc_digest_last_sent_at`. Only counts, slugs and ages are
 * posted, never comment bodies or names.
 */
import { getSetting, setSetting } from "../db/queries";
import type { Bindings } from "../index";
import { discordApi, discordEnabled } from "./discord";
import { log } from "./log";
import { collectDigest, relativeAge } from "./opbot/readouts";
import { publicBaseUrl } from "./public-base";
import { loadDiscordSettings } from "./settings";

// settings key holding the epoch-ms of the last digest post attempt.
const LAST_SENT_KEY = "dc_digest_last_sent_at";
// Same cadence as the Telegram digest: slightly under 24h.
const INTERVAL_MS = 23 * 3600 * 1000;

const renderDigest = async (env: Bindings, now: number): Promise<string> => {
	const d = await collectDigest(env, now);
	const base = publicBaseUrl(env);

	const lines: string[] = ["**Garrul daily digest**"];
	lines.push(
		`• Pending: **${d.pending}**`,
		`• Open reports: **${d.openReports}**${
			d.topFlagged
				? ` — most on \`${d.topFlagged.slug.replace(/`/g, "")}\` (${d.topFlagged.count})`
				: ""
		}`,
		`• Spam (7d): **${d.spamPct}%** of ${d.spamTotal}`,
		`• Banned users: **${d.banned}**`,
	);
	if (d.oldestAgeMs !== null) {
		lines.push(`• Oldest pending: **${relativeAge(now - d.oldestAgeMs, now)}** old`);
	}
	if (base) {
		lines.push("", `[Open moderation queue](${base}/admin/queue)`);
	}
	return lines.join("\n");
};

export const runDiscordDigest = async (env: Bindings, now: number = Date.now()): Promise<void> => {
	const token = env.DISCORD_BOT_TOKEN;
	if (!token || !discordEnabled(env)) return;

	// Daily gate. A missing or garbage stored value reads as "never sent".
	const last = Number(await getSetting(env.DB, LAST_SENT_KEY));
	if (Number.isFinite(last) && last > 0 && now - last < INTERVAL_MS) return;

	// No channel configured: do nothing and DON'T stamp the clock, so the first
	// tick after an operator picks a channel posts a digest.
	const { digestChannelId } = await loadDiscordSettings(env);
	if (!digestChannelId) return;

	const content = await renderDigest(env, now);
	const res = await discordApi(token, "POST", `/channels/${digestChannelId}/messages`, {
		content,
		allowed_mentions: { parse: [] },
	});
	if (!res.ok) log.warn("discord.digest.failed", { status: res.status });

	// Stamp once a post has been attempted, even when it failed, so one bad
	// channel does not retry every 15 minutes. The next day retries.
	await setSetting(env.DB, LAST_SENT_KEY, String(now));
	if (res.ok) log.info("discord.digest.sent", {});
};
