/**
 * Inbound Telegram route — the interactive side of the operator bot.
 *
 * Mounted at top-level `/telegram` (see src/index.ts), deliberately OUTSIDE
 * `/api/*` so it bypasses corsAndCsrf (which 403s originless requests) and
 * sessionMiddleware (cookie-based). The only authentication is Telegram's own
 * mechanism: the X-Telegram-Bot-Api-Secret-Token header, set at setWebhook
 * time and compared (constant-time) against TELEGRAM_WEBHOOK_SECRET.
 *
 * Two kinds of update are handled:
 *   - callback_query — an inline-button tap on a notification. Decoded to an
 *     action + comment id, gated on the linked operator's *current* role, then
 *     run through the shared moderation service (same audit row + webhook +
 *     cache bust as a dashboard click).
 *   - message — `/start <code>` account linking (Phase 2) and slash-command
 *     queries (Phase 3).
 *
 * After the secret check passes we always return 200, even on internal errors:
 * a non-2xx makes Telegram redeliver the same update indefinitely.
 */
import { Hono } from "hono";
import {
	adminOldestPending,
	adminOpenReportSummary,
	adminSpamRate,
	adminStats,
	countOpenReportsByComment,
	getComment,
	getTelegramLinkByTgUser,
	getUser,
	type User,
	upsertTelegramLink,
} from "../db/queries";
import type { Bindings } from "../index";
import { log } from "../lib/log";
import {
	banUser,
	type CommentAction,
	moderateComment,
	resolveReports,
} from "../lib/moderation";
import { randomHex } from "../lib/oauth";
import { checkRateLimit } from "../lib/ratelimit";
import {
	answerCallbackQuery,
	decodeCallback,
	editMessageText,
	SECRET_HEADER,
	sendMessage,
	type TgAction,
	type TgCallbackQuery,
	type TgMessage,
	type TgUpdate,
	verifyTelegramSecret,
} from "../lib/telegram";
import { t } from "../i18n";

export const telegram = new Hono<{ Bindings: Bindings }>();

// --------------------------- Link-token KV flow ---------------------------
//
// Linking is a short-lived one-time token issued in the admin panel and
// redeemed via `/start <token>` to the bot. Stored in OAUTH_STATE (reused
// namespace) under a dedicated prefix so it can't collide with OAuth state.
const LINK_TOKEN_TTL = 600; // 10 minutes
const linkKey = (token: string): string => `tg:link:${token}`;
const LINK_TOKEN_RE = /^[0-9a-f]{48}$/;

/** Issue a one-time link token for `user_id`. Called by the admin route. */
export const issueTelegramLinkToken = async (
	kv: KVNamespace,
	user_id: string,
): Promise<string> => {
	const token = randomHex(24);
	await kv.put(
		linkKey(token),
		JSON.stringify({ user_id, created_at: Date.now() }),
		{ expirationTtl: LINK_TOKEN_TTL },
	);
	return token;
};

const consumeLinkToken = async (
	kv: KVNamespace,
	token: string,
): Promise<string | null> => {
	if (!LINK_TOKEN_RE.test(token)) return null;
	const raw = await kv.get(linkKey(token));
	if (!raw) return null;
	await kv.delete(linkKey(token)); // one-time use
	try {
		const parsed = JSON.parse(raw) as { user_id?: string };
		return parsed.user_id ?? null;
	} catch {
		return null;
	}
};

// ------------------------------- Authorization ----------------------------

const hasRole = (user: User, need: "mod" | "admin"): boolean =>
	!user.is_banned &&
	(need === "mod"
		? user.role === "mod" || user.role === "admin"
		: user.role === "admin");

/** The action's minimum role. Ban is admin-only, matching the HTTP routes. */
const requiredRole = (action: TgAction): "mod" | "admin" =>
	action === "ban" ? "admin" : "mod";

// ------------------------------- Route -------------------------------------

// Inbound callers are authenticated operators (secret token → linked account →
// per-action role check), so the comment-posting default (1/10s, 5/10min) is
// far too strict — a moderator tapping through a queue or running a couple of
// slash commands would be throttled mid-session. Keep a generous burst that
// still caps a runaway loop or a redelivery storm.
const TELEGRAM_RATE_LIMIT = {
	short: { max: 10, windowSec: 10 },
	long: { max: 120, windowSec: 600 },
};

telegram.post("/webhook", async (c) => {
	// 1. Authenticate the caller. This is the ONLY gate on an originless route.
	if (
		!verifyTelegramSecret(
			c.req.header(SECRET_HEADER),
			c.env.TELEGRAM_WEBHOOK_SECRET,
		)
	) {
		// Not Telegram (or a stale secret): a real 403, not an ack.
		return c.json({ error: "unauthorized" }, 403);
	}

	const token = c.env.TELEGRAM_BOT_TOKEN;
	if (!token) {
		// Secret set but token missing — misconfiguration. Ack so Telegram
		// doesn't hammer us; the operator sees the error in the logs.
		log.error("telegram.no_token", {});
		return c.json({ ok: true });
	}

	const update = await c.req.json<TgUpdate>().catch(() => null);
	if (!update) return c.json({ ok: true });

	// Per-sender rate limit (Telegram is the source IP, so key on the tg user).
	const fromId =
		update.callback_query?.from?.id ?? update.message?.from?.id ?? null;
	if (fromId != null) {
		const rl = await checkRateLimit(c.env, `tg:${fromId}`, TELEGRAM_RATE_LIMIT);
		if (!rl.ok) {
			// Tell the operator instead of dropping silently. Callbacks answer as
			// a toast; messages get a reply so a throttled command isn't a no-op.
			if (update.callback_query) {
				await answerCallbackQuery(
					token,
					update.callback_query.id,
					t("telegram.ratelimited"),
				);
			} else if (update.message) {
				await sendMessage(
					token,
					update.message.chat.id,
					t("telegram.ratelimited"),
				);
			}
			return c.json({ ok: true });
		}
	}

	// Handlers never throw past here — but if one does, swallow + ack so the
	// update isn't redelivered in a loop.
	try {
		if (update.callback_query) {
			await handleCallback(
				c.env,
				token,
				update.callback_query,
				c.executionCtx,
			);
		} else if (update.message) {
			await handleMessage(c.env, token, update.message);
		}
	} catch (err) {
		log.error("telegram.handler", { error: String(err) });
	}
	return c.json({ ok: true });
});

// ----------------------------- Callback handler ----------------------------

const handleCallback = async (
	env: Bindings,
	token: string,
	cq: TgCallbackQuery,
	executionCtx: { waitUntil(p: Promise<unknown>): void },
): Promise<void> => {
	const decoded = decodeCallback(cq.data);
	if (!decoded) {
		await answerCallbackQuery(token, cq.id, t("telegram.unknown_action"));
		return;
	}

	// Resolve identity → current user → role. The link is identity only; the
	// role is re-checked here every time, so revoking mod/admin disables the
	// buttons even while the link persists.
	const link = await getTelegramLinkByTgUser(env.DB, String(cq.from.id));
	if (!link) {
		await answerCallbackQuery(token, cq.id, t("telegram.not_linked"));
		return;
	}
	const user = await getUser(env.DB, link.user_id);
	if (!user || !hasRole(user, requiredRole(decoded.action))) {
		await answerCallbackQuery(token, cq.id, t("telegram.not_authorized"));
		return;
	}

	const outcome = await runAction(
		env,
		user,
		decoded.action,
		decoded.commentId,
		executionCtx,
	);
	await answerCallbackQuery(token, cq.id, outcome.toast);

	// Reflect the result in the message and strip the keyboard so the buttons
	// can't be tapped twice. editMessageText with no reply_markup removes it.
	if (cq.message) {
		await editMessageText(
			token,
			cq.message.chat.id,
			cq.message.message_id,
			// cq.message.text is Telegram's plain-text rendering of our original
			// message (entities stripped), so any literal & < > in it must be
			// re-escaped before it goes back out under parse_mode=HTML — otherwise
			// the edit fails and the stale keyboard stays tappable.
			`${cq.message.text ? `${escapeTg(cq.message.text)}\n\n` : ""}<b>${outcome.toast}</b> — ${escapeTg(user.name)}`,
		);
	}
};

// Run the decoded action through the shared moderation service. Returns a
// short toast for answerCallbackQuery. bustTreeCache keys on the Worker
// origin, so we pass PUBLIC_BASE_URL as the synthetic request URL.
const runAction = async (
	env: Bindings,
	user: User,
	action: TgAction,
	commentId: string,
	executionCtx: { waitUntil(p: Promise<unknown>): void },
): Promise<{ toast: string }> => {
	const reqUrl = env.PUBLIC_BASE_URL ?? "https://localhost";

	if (action === "resolve") {
		const res = await resolveReports({
			env,
			adminId: user.id,
			commentId,
		});
		if (!res.ok) return { toast: t("telegram.comment_not_found") };
		return { toast: t("telegram.reports_resolved", { count: res.resolved }) };
	}

	if (action === "ban") {
		const comment = await getComment(env.DB, commentId);
		if (!comment) return { toast: t("telegram.comment_not_found") };
		const res = await banUser({
			env,
			adminId: user.id,
			userId: comment.user_id,
			banned: true,
			fromComment: commentId,
		});
		if (!res.ok) return { toast: t("telegram.comment_not_found") };
		return { toast: t("telegram.author_banned") };
	}

	// approve | spam | delete | restore → a CommentAction.
	const res = await moderateComment({
		env,
		executionCtx,
		reqUrl,
		adminId: user.id,
		commentId,
		action: action as CommentAction,
	});
	if (!res.ok) return { toast: t("telegram.comment_not_found") };
	return { toast: t("telegram.action_applied", { action }) };
};

// ----------------------------- Message handler -----------------------------

// Parse "/cmd arg" — tolerating the "/cmd@BotName" form Telegram uses in
// groups. Returns null for non-command text.
const parseCommand = (text: string): { name: string; arg: string } | null => {
	if (!text.startsWith("/")) return null;
	const sp = text.indexOf(" ");
	const head = sp === -1 ? text.slice(1) : text.slice(1, sp);
	const arg = sp === -1 ? "" : text.slice(sp + 1).trim();
	const name = (head.split("@")[0] ?? "").toLowerCase();
	return { name, arg };
};

const handleMessage = async (
	env: Bindings,
	token: string,
	msg: TgMessage,
): Promise<void> => {
	const text = (msg.text ?? "").trim();
	const chatId = msg.chat.id;
	const cmd = parseCommand(text);

	// Linking is the one command that works before a link exists.
	if (cmd?.name === "start") {
		await handleStart(env, token, msg, cmd.arg);
		return;
	}
	if (!cmd) {
		await sendMessage(token, chatId, t("telegram.start_help"));
		return;
	}

	// Every query command requires a linked operator with at least mod role,
	// re-checked here (the link is identity only).
	const link = msg.from
		? await getTelegramLinkByTgUser(env.DB, String(msg.from.id))
		: null;
	if (!link) {
		await sendMessage(token, chatId, t("telegram.not_linked"));
		return;
	}
	const user = await getUser(env.DB, link.user_id);
	if (!user || !hasRole(user, "mod")) {
		await sendMessage(token, chatId, t("telegram.not_authorized"));
		return;
	}

	switch (cmd.name) {
		case "queue":
			await sendMessage(token, chatId, await renderQueueText(env));
			break;
		case "stats":
			await sendMessage(token, chatId, await renderStatsText(env));
			break;
		case "comment":
			await sendMessage(token, chatId, await renderCommentText(env, cmd.arg));
			break;
		case "user":
			await sendMessage(token, chatId, await renderUserText(env, cmd.arg));
			break;
		default:
			await sendMessage(token, chatId, commandHelpText());
	}
};

// ----------------------------- Command renderers ---------------------------
//
// Read-only operator readouts. Dynamic values are HTML-escaped (parse_mode is
// HTML); like the slack/discord adapters, the fixed framing is composed inline
// rather than via t() — only the gate messages use the string table.

const commandHelpText = (): string =>
	[
		"<b>Garrul operator bot</b>",
		"/queue — pending + reported counts",
		"/stats — totals and 7-day spam rate",
		"/comment &lt;id&gt; — a comment's status + author",
		"/user &lt;id&gt; — a user's role + status",
	].join("\n");

const relativeAge = (since: number, now: number): string => {
	const ms = Math.max(0, now - since);
	const mins = Math.floor(ms / 60000);
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h`;
	return `${Math.floor(hrs / 24)}d`;
};

const adminCommentUrl = (env: Bindings, id: string): string | null =>
	env.PUBLIC_BASE_URL
		? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin/comments/${encodeURIComponent(id)}`
		: null;

const renderQueueText = async (env: Bindings): Promise<string> => {
	const [stats, oldest, reports] = await Promise.all([
		adminStats(env.DB),
		adminOldestPending(env.DB),
		adminOpenReportSummary(env.DB),
	]);
	const lines = [
		"<b>Moderation queue</b>",
		`⏳ Pending: <b>${stats.pending_comments}</b>`,
		`🚩 Reported: <b>${reports.open}</b>`,
		`🚫 Spam: <b>${stats.spam_comments}</b>`,
	];
	if (reports.top) {
		lines.push(
			`Most flagged: <code>${escapeTg(reports.top.slug)}</code> (${reports.top.count})`,
		);
	}
	if (oldest) {
		const age = relativeAge(oldest.created_at, Date.now());
		const url = adminCommentUrl(env, oldest.id);
		lines.push(
			`Oldest pending: ${age} ago${url ? ` — ${tgLink(url, "open")}` : ""}`,
		);
	}
	return lines.join("\n");
};

const renderStatsText = async (env: Bindings): Promise<string> => {
	const [stats, spam] = await Promise.all([
		adminStats(env.DB),
		adminSpamRate(env.DB, 7),
	]);
	const pct =
		spam.total > 0 ? Math.round((spam.spam / spam.total) * 100) : 0;
	return [
		"<b>Stats</b>",
		`💬 Comments: <b>${stats.total_comments}</b> (${stats.pending_comments} pending)`,
		`👥 Users: <b>${stats.total_users}</b> (${stats.banned_users} banned)`,
		`🚫 Spam rate (7d): <b>${pct}%</b> (${spam.spam}/${spam.total})`,
	].join("\n");
};

const renderCommentText = async (
	env: Bindings,
	arg: string,
): Promise<string> => {
	const id = arg.trim();
	if (!id) return "Usage: /comment &lt;id&gt;";
	const comment = await getComment(env.DB, id);
	if (!comment) return t("telegram.comment_not_found");
	const [author, reportCounts] = await Promise.all([
		getUser(env.DB, comment.user_id),
		countOpenReportsByComment(env.DB, [id]),
	]);
	const openReports = reportCounts[id] ?? 0;
	const snippet =
		comment.body_md.length > 200
			? `${comment.body_md.slice(0, 200)}…`
			: comment.body_md;
	const url = adminCommentUrl(env, id);
	const lines = [
		`<b>Comment</b> <code>${escapeTg(id)}</code>`,
		`Status: <b>${escapeTg(comment.status)}</b>${openReports > 0 ? ` · ${openReports} open report(s)` : ""}`,
		`Author: ${escapeTg(author?.name ?? "unknown")}`,
		`On: <code>${escapeTg(comment.post_slug)}</code> · ${relativeAge(comment.created_at, Date.now())} ago`,
		`<blockquote>${escapeTg(snippet)}</blockquote>`,
	];
	if (url) lines.push(tgLink(url, "🔍 Open in admin"));
	return lines.join("\n");
};

const renderUserText = async (env: Bindings, arg: string): Promise<string> => {
	const id = arg.trim();
	if (!id) return "Usage: /user &lt;id&gt;";
	const user = await getUser(env.DB, id);
	if (!user) return "No such user.";
	return [
		`<b>User</b> <code>${escapeTg(id)}</code>`,
		`Name: ${escapeTg(user.name)}`,
		`Role: <b>${escapeTg(user.role)}</b>${user.is_banned ? " · ⛔ banned" : ""}`,
		`Provider: ${escapeTg(user.provider)}`,
		`Joined: ${relativeAge(user.created_at, Date.now())} ago`,
	].join("\n");
};

const tgLink = (url: string, label: string): string =>
	`<a href="${escapeTg(url)}">${escapeTg(label)}</a>`;

const handleStart = async (
	env: Bindings,
	token: string,
	msg: TgMessage,
	code: string,
): Promise<void> => {
	const chatId = msg.chat.id;
	if (!code) {
		await sendMessage(token, chatId, t("telegram.start_help"));
		return;
	}

	const userId = await consumeLinkToken(env.OAUTH_STATE, code);
	if (!userId) {
		await sendMessage(token, chatId, t("telegram.link_invalid"));
		return;
	}
	const user = await getUser(env.DB, userId);
	if (!user) {
		await sendMessage(token, chatId, t("telegram.link_user_missing"));
		return;
	}
	if (!msg.from) {
		// A /start always carries `from`; guard for the type system.
		await sendMessage(token, chatId, t("telegram.link_invalid"));
		return;
	}

	await upsertTelegramLink(env.DB, {
		tg_user_id: String(msg.from.id),
		tg_chat_id: String(chatId),
		user_id: user.id,
	});
	await sendMessage(token, chatId, t("telegram.link_ok", { name: escapeTg(user.name) }));
};

// Telegram parse_mode=HTML: escape user-derived text placed in messages.
// Quotes are escaped too because this also feeds href="..." attributes via
// tgLink — an unescaped quote there breaks the attribute and Telegram rejects
// the whole message.
const escapeTg = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
