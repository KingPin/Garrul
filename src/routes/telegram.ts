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
	countOpenReportsByComment,
	getSavedReply,
	getUser,
	nextPendingAfter,
	upsertTelegramLink,
} from "../db/queries";
import { t } from "../i18n";
import type { Bindings } from "../index";
import { log } from "../lib/log";
import { hasRole, requiredRole, runOpAction, unbanUser } from "../lib/opbot/actions";
import { buttonsFor, type OpCard, renderQueueCard } from "../lib/opbot/cards";
import { decodePayload, encodePayload } from "../lib/opbot/codec";
import { type OpActor, resolveTelegramActor } from "../lib/opbot/identity";
import { consumeLinkToken, issueLinkToken } from "../lib/opbot/link-token";
import {
	readComment,
	readQueue,
	readStats,
	readUser,
	relativeAge,
} from "../lib/opbot/readouts";
import {
	expandPreset,
	pickerPresets,
	postModeratorReply,
	presetVars,
	presetVisible,
	type ReplyError,
} from "../lib/opbot/reply";
import { checkRateLimit } from "../lib/ratelimit";
import {
	answerCallbackQuery,
	botIdFromToken,
	decodeCallback,
	editMessageText,
	type InlineButton,
	SECRET_HEADER,
	sendMessage,
	type TgCallbackQuery,
	type TgMessage,
	type TgUpdate,
	toInlineKeyboard,
	verifyTelegramSecret,
} from "../lib/telegram";

export const telegram = new Hono<{ Bindings: Bindings }>();

// --------------------------- Link-token KV flow ---------------------------
//
// Linking is a one-time token issued in the admin panel and redeemed via
// `/start <token>`. The KV logic is shared with Discord (src/lib/opbot/link-token.ts).
/** Issue a one-time link token for `user_id`. Called by the admin route. */
export const issueTelegramLinkToken = (
	kv: KVNamespace,
	user_id: string,
): Promise<string> => issueLinkToken(kv, "tg", user_id);

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
		const rl = await checkRateLimit(c.req.url, `tg:${fromId}`, {
			scope: "telegram",
			config: TELEGRAM_RATE_LIMIT,
			env: c.env,
		});
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
			await handleMessage(c.env, token, update.message, c.executionCtx);
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

	// Identity → current role, re-checked on every tap. The link is identity
	// only, so revoking mod/admin disables the buttons while the link persists.
	const who = await resolveTelegramActor(env.DB, String(cq.from.id));
	if (!who.ok) {
		await answerCallbackQuery(
			token,
			cq.id,
			t(
				who.reason === "not_linked"
					? "telegram.not_linked"
					: "telegram.not_authorized",
			),
		);
		return;
	}
	const { actor } = who;
	if (!hasRole(actor, requiredRole(decoded.action))) {
		await answerCallbackQuery(token, cq.id, t("telegram.not_authorized"));
		return;
	}
	const extra = decodePayload(cq.data)?.extra ?? [];
	if (
		decoded.action === "reply" ||
		decoded.action === "sr" ||
		decoded.action === "rc"
	) {
		await handleReplyTap(env, token, cq, decoded, extra, actor, executionCtx);
		return;
	}
	if (decoded.action === "banr") {
		await answerCallbackQuery(token, cq.id);
		if (cq.message) {
			await sendMessage(
				token,
				cq.message.chat.id,
				`Ban reason for comment <code>${escapeTg(decoded.commentId)}</code> — send the reason as a reply to this message.`,
				{ replyMarkup: { force_reply: true, selective: true } },
			);
		}
		return;
	}
	if (decoded.action === "rv" || decoded.action === "nx") {
		await answerCallbackQuery(token, cq.id);
		const next = await nextPendingAfter(
			env.DB,
			decoded.action === "rv" ? null : decoded.commentId,
		);
		if (cq.message) {
			const card = next ? await renderQueueCard(env, next) : null;
			await editMessageText(
				token,
				cq.message.chat.id,
				cq.message.message_id,
				card ? tgCardText(card) : "Queue is empty 🎉",
				card
					? {
							replyMarkup: {
								// Action rows carry "q" so the post-action keyboard keeps
								// Next; the Next row (last) does not.
								inline_keyboard: [
									...toInlineKeyboard(card.buttons.slice(0, -1), card.commentId, ["q"])
										.inline_keyboard,
									...toInlineKeyboard(card.buttons.slice(-1), card.commentId)
										.inline_keyboard,
								],
							},
						}
					: undefined,
			);
		}
		return;
	}
	// TG_HANDLED guarantees one of the six actions runOpAction accepts.
	const action = decoded.action as
		| "approve"
		| "spam"
		| "delete"
		| "restore"
		| "resolve"
		| "ban";

	// runOpAction does not report how many reports it closed; read it first.
	const openBefore =
		action === "resolve"
			? ((await countOpenReportsByComment(env.DB, [decoded.commentId]))[
					decoded.commentId
				] ?? 0)
			: 0;
	const res = await runOpAction({
		env,
		executionCtx,
		actor,
		action,
		commentId: decoded.commentId,
	});
	if (!res.ok) {
		await answerCallbackQuery(
			token,
			cq.id,
			t(
				res.error === "comment_not_found"
					? "telegram.comment_not_found"
					: res.error === "not_authorized"
						? "telegram.not_authorized"
						: "telegram.ban_refused",
			),
		);
		return;
	}
	await answerCallbackQuery(
		token,
		cq.id,
		action === "resolve"
			? t("telegram.reports_resolved", { count: openBefore })
			: action === "ban"
				? t("telegram.author_banned")
				: t("telegram.action_applied", { action }),
	);

	// Keep the message text, add who did what, and show the keyboard for the
	// comment's new status.
	if (cq.message) {
		await editMessageText(
			token,
			cq.message.chat.id,
			cq.message.message_id,
			// cq.message.text is Telegram's plain-text rendering of our original
			// message (entities stripped), so any literal & < > in it must be
			// re-escaped before it goes back out under parse_mode=HTML — otherwise
			// the edit fails and the stale keyboard stays tappable.
			`${cq.message.text ? `${escapeTg(cq.message.text)}\n\n` : ""}<b>${escapeTg(res.doneBy)}</b>`,
			{
				replyMarkup: toInlineKeyboard(
					buttonsFor(res.status, {
						reported: res.reported,
						queue: extra[0] === "q",
					}),
					decoded.commentId,
					extra,
				),
			},
		);
	}
};

// ------------------------------- Reply flow --------------------------------

const REPLY_REFUSAL = (e: ReplyError, max?: number): string =>
	e === "comment_not_found"
		? t("telegram.comment_not_found")
		: e === "comment_deleted"
			? "That comment was deleted."
			: e === "thread_too_deep"
				? "That thread is too deep to reply to. Reply higher up from the dashboard."
				: e === "body_too_long"
					? `Reply too long (max ${max} characters).`
					: e === "body_required"
						? "Reply text is empty."
						: "That saved reply isn't available here.";

const MAX_PRESET_BUTTONS = 99;

const handleReplyTap = async (
	env: Bindings,
	token: string,
	cq: TgCallbackQuery,
	decoded: { action: string; commentId: string },
	extra: string[],
	actor: OpActor,
	executionCtx: { waitUntil(p: Promise<unknown>): void },
): Promise<void> => {
	await answerCallbackQuery(token, cq.id);
	const msg = cq.message;
	if (!msg) return;
	const chatId = msg.chat.id;
	const cid = decoded.commentId;
	const ctx = { chat: msg.chat.type === "private" ? "private" : "group" } as const;

	if (decoded.action === "reply") {
		const rows: InlineButton[][] = [];
		for (const p of await pickerPresets(env.DB, actor.user.id, ctx)) {
			if (rows.length >= MAX_PRESET_BUTTONS) break;
			let data: string;
			try {
				data = encodePayload("telegram", "sr", cid, [p.id]);
			} catch {
				continue; // id too long for a callback payload
			}
			const label = p.title.length > 60 ? `${p.title.slice(0, 60)}…` : p.title;
			rows.push([{ text: label, callback_data: data }]);
		}
		rows.push([{ text: "✏️ Write custom", callback_data: encodePayload("telegram", "rc", cid) }]);
		await sendMessage(token, chatId, `Reply to comment <code>${escapeTg(cid)}</code>:`, {
			replyMarkup: { inline_keyboard: rows },
		});
		return;
	}
	if (decoded.action === "rc") {
		await sendMessage(
			token,
			chatId,
			`Reply to comment <code>${escapeTg(cid)}</code> — send your text as a reply to this message.`,
			{ replyMarkup: { force_reply: true, selective: true } },
		);
		return;
	}

	// sr: post the chosen preset.
	const preset = extra[0] ? await getSavedReply(env.DB, extra[0]) : null;
	if (!preset || !presetVisible(preset, actor.user.id, ctx)) {
		await sendMessage(token, chatId, REPLY_REFUSAL("saved_reply_not_visible"));
		return;
	}
	const res = await postModeratorReply({
		env,
		executionCtx,
		reqUrl: env.PUBLIC_BASE_URL ?? "https://invalid.local/",
		actor: actor.user,
		commentId: cid,
		bodyMd: expandPreset(preset.body_md, await presetVars(env, cid, actor.user)),
		savedReplyId: preset.id,
	});
	if (!res.ok) {
		await sendMessage(token, chatId, REPLY_REFUSAL(res.error, res.max));
		return;
	}
	await editMessageText(
		token,
		chatId,
		msg.message_id,
		`Reply posted by ${escapeTg(actor.user.name)}`,
	);
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

// A reply to one of the bot's force_reply prompts.
const PROMPT_RE = /^(Ban reason for|Reply to) comment ([0-9A-HJKMNP-TV-Z]{26})\b/;

const handlePromptAnswer = async (
	env: Bindings,
	token: string,
	msg: TgMessage,
	prompt: RegExpMatchArray,
	text: string,
	executionCtx: { waitUntil(p: Promise<unknown>): void },
): Promise<void> => {
	const chatId = msg.chat.id;
	const who = msg.from
		? await resolveTelegramActor(env.DB, String(msg.from.id))
		: ({ ok: false, reason: "not_linked" } as const);
	if (!who.ok) {
		await sendMessage(
			token,
			chatId,
			t(who.reason === "not_linked" ? "telegram.not_linked" : "telegram.not_authorized"),
		);
		return;
	}
	const { actor } = who;
	const isReply = prompt[1] === "Reply to";
	if (!hasRole(actor, requiredRole(isReply ? "reply" : "banr"))) {
		await sendMessage(token, chatId, t("telegram.not_authorized"));
		return;
	}
	if (isReply) {
		const res = await postModeratorReply({
			env,
			executionCtx,
			reqUrl: env.PUBLIC_BASE_URL ?? "https://invalid.local/",
			actor: actor.user,
			commentId: prompt[2] as string,
			bodyMd: text,
		});
		await sendMessage(
			token,
			chatId,
			res.ok
				? `Reply posted by ${escapeTg(actor.user.name)}`
				: REPLY_REFUSAL(res.error, res.max),
		);
		return;
	}
	const res = await runOpAction({
		env,
		executionCtx,
		actor,
		action: "ban",
		commentId: prompt[2] as string,
		reason: text.slice(0, 500),
	});
	await sendMessage(
		token,
		chatId,
		res.ok
			? `<b>${escapeTg(res.doneBy)}</b>`
			: t(
					res.error === "comment_not_found"
						? "telegram.comment_not_found"
						: res.error === "not_authorized"
							? "telegram.not_authorized"
							: "telegram.ban_refused",
				),
	);
};

const handleMessage = async (
	env: Bindings,
	token: string,
	msg: TgMessage,
	executionCtx: { waitUntil(p: Promise<unknown>): void },
): Promise<void> => {
	const text = (msg.text ?? "").trim();
	const chatId = msg.chat.id;

	// Prompt answers come first: only a reply to one of the bot's own prompts
	// counts, and the actor is re-resolved from the sender, never the prompt.
	const replied = msg.reply_to_message;
	const botId = botIdFromToken(token);
	if (replied?.from?.id !== undefined && replied.from.id === botId) {
		const prompt = (replied.text ?? "").match(PROMPT_RE);
		if (prompt) {
			if (text) await handlePromptAnswer(env, token, msg, prompt, text, executionCtx);
			return;
		}
	}
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
	const who = msg.from
		? await resolveTelegramActor(env.DB, String(msg.from.id))
		: ({ ok: false, reason: "not_linked" } as const);
	if (!who.ok) {
		await sendMessage(
			token,
			chatId,
			t(
				who.reason === "not_linked"
					? "telegram.not_linked"
					: "telegram.not_authorized",
			),
		);
		return;
	}

	switch (cmd.name) {
		case "queue":
			await sendMessage(token, chatId, await renderQueueText(env), {
					replyMarkup: {
						inline_keyboard: [[{ text: "Review ▶", callback_data: "g:rv:-" }]],
					},
				});
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
		case "unban":
			await sendMessage(token, chatId, await runUnban(env, who.actor, cmd.arg));
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

const runUnban = async (
	env: Bindings,
	actor: OpActor,
	arg: string,
): Promise<string> => {
	const id = arg.trim();
	if (!id) return "Usage: /unban &lt;id&gt;";
	if (!hasRole(actor, requiredRole("unban"))) return t("telegram.not_authorized");
	const res = await unbanUser({ env, actor, userId: id });
	if (!res.ok) {
		return res.error === "not_found"
			? "No such user."
			: res.error === "target_is_staff"
				? "You can't unban a moderator or admin."
				: t("telegram.not_authorized");
	}
	const user = await getUser(env.DB, id);
	return `Unbanned ${escapeTg(user?.name ?? id)}.`;
};

const commandHelpText = (): string =>
	[
		"<b>Garrul operator bot</b>",
		"/queue — pending + reported counts",
		"/stats — totals and 7-day spam rate",
		"/comment &lt;id&gt; — a comment's status + author",
		"/user &lt;id&gt; — a user's role + status",
		"/unban &lt;id&gt; — lift a ban",
	].join("\n");

const adminCommentUrl = (env: Bindings, id: string): string | null =>
	env.PUBLIC_BASE_URL
		? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin/comments/${encodeURIComponent(id)}`
		: null;

const renderQueueText = async (env: Bindings): Promise<string> => {
	const q = await readQueue(env);
	const lines = [
		"<b>Moderation queue</b>",
		`⏳ Pending: <b>${q.pending}</b>`,
		`🚩 Reported: <b>${q.reported}</b>`,
		`🚫 Spam: <b>${q.spam}</b>`,
	];
	if (q.topFlagged) {
		lines.push(
			`Most flagged: <code>${escapeTg(q.topFlagged.slug)}</code> (${q.topFlagged.count})`,
		);
	}
	if (q.oldest) {
		const age = relativeAge(q.oldest.created_at, Date.now());
		const url = adminCommentUrl(env, q.oldest.id);
		lines.push(
			`Oldest pending: ${age} ago${url ? ` — ${tgLink(url, "open")}` : ""}`,
		);
	}
	return lines.join("\n");
};

const renderStatsText = async (env: Bindings): Promise<string> => {
	const s = await readStats(env);
	const pct =
		s.spam7d.total > 0 ? Math.round((s.spam7d.spam / s.spam7d.total) * 100) : 0;
	return [
		"<b>Stats</b>",
		`💬 Comments: <b>${s.totalComments}</b> (${s.pending} pending)`,
		`👥 Users: <b>${s.totalUsers}</b> (${s.banned} banned)`,
		`🚫 Spam rate (7d): <b>${pct}%</b> (${s.spam7d.spam}/${s.spam7d.total})`,
	].join("\n");
};

const renderCommentText = async (
	env: Bindings,
	arg: string,
): Promise<string> => {
	const id = arg.trim();
	if (!id) return "Usage: /comment &lt;id&gt;";
	const r = await readComment(env, id);
	if (!r) return t("telegram.comment_not_found");
	const { comment, authorName, openReports } = r;
	const snippet =
		comment.body_md.length > 200
			? `${comment.body_md.slice(0, 200)}…`
			: comment.body_md;
	const url = adminCommentUrl(env, id);
	const lines = [
		`<b>Comment</b> <code>${escapeTg(id)}</code>`,
		`Status: <b>${escapeTg(comment.status)}</b>${openReports > 0 ? ` · ${openReports} open report(s)` : ""}`,
		`Author: ${escapeTg(authorName)}`,
		`On: <code>${escapeTg(comment.post_slug)}</code> · ${relativeAge(comment.created_at, Date.now())} ago`,
		`<blockquote>${escapeTg(snippet)}</blockquote>`,
	];
	if (url) lines.push(tgLink(url, "🔍 Open in admin"));
	return lines.join("\n");
};

const renderUserText = async (env: Bindings, arg: string): Promise<string> => {
	const id = arg.trim();
	if (!id) return "Usage: /user &lt;id&gt;";
	const r = await readUser(env, id);
	if (!r) return "No such user.";
	const { user, ban } = r;
	return [
		`<b>User</b> <code>${escapeTg(id)}</code>`,
		`Name: ${escapeTg(user.name)}`,
		`Role: <b>${escapeTg(user.role)}</b>`,
		`Provider: ${escapeTg(user.provider)}`,
		`Joined: ${relativeAge(user.created_at, Date.now())} ago`,
		!ban.banned
			? "Not banned"
			: ban.purged
				? "Banned — reason no longer available"
				: ban.reason
					? `Banned — ${escapeTg(ban.reason)}`
					: "Banned — no reason given",
	].join("\n");
};

const tgCardText = (card: OpCard): string =>
	[
		`<b>${escapeTg(card.title)}</b>`,
		...card.lines.map(escapeTg),
		...(card.snippet ? [`<blockquote>${escapeTg(card.snippet)}</blockquote>`] : []),
		...(card.adminUrl ? [tgLink(card.adminUrl, "🔍 Open in admin")] : []),
	].join("\n");

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

	const userId = await consumeLinkToken(env.OAUTH_STATE, "tg", code);
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
