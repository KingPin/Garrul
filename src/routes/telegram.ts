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
		const rl = await checkRateLimit(c.env, `tg:${fromId}`);
		if (!rl.ok) {
			if (update.callback_query) {
				await answerCallbackQuery(
					token,
					update.callback_query.id,
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
			await handleCallback(c.env, token, update.callback_query);
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

	const outcome = await runAction(env, user, decoded.action, decoded.commentId);
	await answerCallbackQuery(token, cq.id, outcome.toast);

	// Reflect the result in the message and strip the keyboard so the buttons
	// can't be tapped twice. editMessageText with no reply_markup removes it.
	if (cq.message) {
		await editMessageText(
			token,
			cq.message.chat.id,
			cq.message.message_id,
			`${cq.message.text ? `${cq.message.text}\n\n` : ""}<b>${outcome.toast}</b> — ${escapeName(user.name)}`,
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
		executionCtx: undefined,
		reqUrl,
		adminId: user.id,
		commentId,
		action: action as CommentAction,
	});
	if (!res.ok) return { toast: t("telegram.comment_not_found") };
	return { toast: t("telegram.action_applied", { action }) };
};

// ----------------------------- Message handler -----------------------------

const handleMessage = async (
	env: Bindings,
	token: string,
	msg: TgMessage,
): Promise<void> => {
	const text = (msg.text ?? "").trim();
	const chatId = msg.chat.id;

	if (text.startsWith("/start")) {
		await handleStart(env, token, msg, text);
		return;
	}

	// Phase 3 wires slash-command queries here. Until then, point operators at
	// the linking flow for anything else.
	await sendMessage(token, chatId, t("telegram.start_help"));
};

const handleStart = async (
	env: Bindings,
	token: string,
	msg: TgMessage,
	text: string,
): Promise<void> => {
	const chatId = msg.chat.id;
	const code = text.slice("/start".length).trim();
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
	await sendMessage(token, chatId, t("telegram.link_ok", { name: escapeName(user.name) }));
};

// Telegram parse_mode=HTML: escape user-derived text placed in messages.
const escapeName = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
