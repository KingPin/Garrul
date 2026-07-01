/**
 * Telegram Bot API client + protocol helpers for the operator bot.
 *
 * Two seams use Telegram:
 *   - Outbound notifications go through the webhook adapter (renderTelegramBody
 *     in webhook-adapters.ts) so they inherit event filtering + the retry
 *     queue. That path builds its own sendMessage body.
 *   - This module backs the *interactive* side: the inbound /telegram route
 *     (src/routes/telegram.ts) calls these helpers to answer callback queries,
 *     edit message keyboards, and reply to slash commands. It also owns the
 *     callback_data codec and the moderation inline keyboard shared with the
 *     outbound renderer.
 *
 * The bot token is always an env secret (TELEGRAM_BOT_TOKEN); it is never
 * stored in D1 and never logged. Every call composes the API URL from the
 * token at call time.
 */
import { log } from "./log";
import type { WebhookEvent } from "./webhook";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TIMEOUT_MS = 5000;

// ----------------------------- Update types -------------------------------
//
// Minimal shapes for the slice of the Telegram Update object we consume. The
// Bot API sends far more; we read only what the bot acts on and ignore the
// rest, so unknown fields are harmless.

export type TgUser = {
	id: number;
	is_bot?: boolean;
	username?: string;
	first_name?: string;
};

export type TgChat = {
	id: number;
	type?: string;
};

export type TgMessage = {
	message_id: number;
	chat: TgChat;
	from?: TgUser;
	text?: string;
};

export type TgCallbackQuery = {
	id: string;
	from: TgUser;
	message?: TgMessage;
	data?: string;
};

export type TgUpdate = {
	update_id: number;
	message?: TgMessage;
	callback_query?: TgCallbackQuery;
};

// ----------------------------- Secret verify ------------------------------
//
// Telegram echoes the secret configured at setWebhook time in this header on
// every inbound update. It is the only authentication on the originless
// /telegram route (which sits outside corsAndCsrf + sessionMiddleware), so the
// comparison must be constant-time to avoid leaking the secret via timing.
export const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export const verifyTelegramSecret = (
	headerValue: string | null | undefined,
	expected: string | undefined,
): boolean => {
	if (!expected) return false; // feature off / misconfigured → reject
	if (typeof headerValue !== "string") return false;
	return timingSafeEqual(headerValue, expected);
};

// Constant-time string compare. Lengths leak (unavoidable without hashing),
// but the per-byte loop runs over the longer of the two so content does not.
const timingSafeEqual = (a: string, b: string): boolean => {
	const enc = new TextEncoder();
	const ab = enc.encode(a);
	const bb = enc.encode(b);
	const len = Math.max(ab.length, bb.length);
	let diff = ab.length ^ bb.length;
	for (let i = 0; i < len; i++) {
		diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
	}
	return diff === 0;
};

// --------------------------- callback_data codec --------------------------
//
// Inline-button taps round-trip through Telegram as callback_data, capped at
// 64 bytes. We encode the action + target comment id as "g:<action>:<id>".
// A comment id is a 26-char ULID, so "g:resolve:" (10) + 26 = 36 bytes — well
// under the cap. Ban targets the comment too; the handler resolves the author
// from the comment so we never need to pack a second id.

export type TgAction =
	| "approve"
	| "spam"
	| "delete"
	| "restore"
	| "ban"
	| "resolve";

const CALLBACK_PREFIX = "g";
const TG_ACTIONS: readonly TgAction[] = [
	"approve",
	"spam",
	"delete",
	"restore",
	"ban",
	"resolve",
] as const;

export const CALLBACK_DATA_MAX = 64;

export const encodeCallback = (action: TgAction, commentId: string): string =>
	`${CALLBACK_PREFIX}:${action}:${commentId}`;

export const decodeCallback = (
	data: string | undefined,
): { action: TgAction; commentId: string } | null => {
	if (typeof data !== "string") return null;
	const parts = data.split(":");
	if (parts.length !== 3) return null;
	const [prefix, action, commentId] = parts;
	if (prefix !== CALLBACK_PREFIX) return null;
	if (!TG_ACTIONS.includes(action as TgAction)) return null;
	if (!commentId) return null;
	return { action: action as TgAction, commentId };
};

// --------------------------- Inline keyboard ------------------------------
//
// The moderation button set shown under a notification. Shared with the
// outbound renderer so a tap on a notification posts a callback_query the
// inbound route understands. Buttons are tailored to the event: a spam alert
// offers "Not spam" (restore) instead of "Approve"; a report offers "Resolve
// reports". Every event offers Delete + Ban author.

export type InlineButton = { text: string; callback_data: string };

export const moderationKeyboard = (
	event: WebhookEvent,
	commentId: string,
): { inline_keyboard: InlineButton[][] } => {
	const btn = (text: string, action: TgAction): InlineButton => ({
		text,
		callback_data: encodeCallback(action, commentId),
	});

	const firstRow: InlineButton[] =
		event === "comment.spam"
			? [btn("✅ Not spam", "restore")]
			: [btn("✅ Approve", "approve"), btn("🚫 Spam", "spam")];

	const secondRow: InlineButton[] = [
		btn("🗑 Delete", "delete"),
		btn("⛔ Ban author", "ban"),
	];
	if (event === "comment.reported") {
		secondRow.push(btn("📁 Resolve reports", "resolve"));
	}

	return { inline_keyboard: [firstRow, secondRow] };
};

// ------------------------------ API client --------------------------------
//
// Thin typed wrappers over the Bot API methods the bot calls. Each returns
// { ok } so callers can log a failure without throwing on the request path
// (an inbound webhook that throws would make Telegram retry the whole update).

type TgResult<T = unknown> = { ok: boolean; status: number; result?: T };

const callTelegram = async (
	token: string,
	method: string,
	body: Record<string, unknown>,
): Promise<TgResult> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const json = (await res.json().catch(() => ({}))) as {
			ok?: boolean;
			result?: unknown;
		};
		const ok = res.ok && json.ok !== false;
		// Status-only: no token, chat_id, or message text — the Bot API can echo
		// the request URL (which embeds the token) in errors, so we never log err.
		if (!ok) log.warn("telegram.api_error", { method, status: res.status });
		return { ok, status: res.status, result: json.result };
	} catch {
		log.warn("telegram.api_error", { method, status: 0 });
		return { ok: false, status: 0 };
	} finally {
		clearTimeout(timer);
	}
};

export const sendMessage = (
	token: string,
	chatId: string | number,
	text: string,
	opts: {
		replyMarkup?: { inline_keyboard: InlineButton[][] };
		disablePreview?: boolean;
	} = {},
): Promise<TgResult> =>
	callTelegram(token, "sendMessage", {
		chat_id: chatId,
		text,
		parse_mode: "HTML",
		disable_web_page_preview: opts.disablePreview ?? true,
		...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
	});

export const answerCallbackQuery = (
	token: string,
	callbackQueryId: string,
	text?: string,
): Promise<TgResult> =>
	callTelegram(token, "answerCallbackQuery", {
		callback_query_id: callbackQueryId,
		...(text ? { text } : {}),
	});

// Replace a message's text + strip its keyboard after an action resolves, so
// the buttons can't be tapped twice and the message reflects the outcome.
export const editMessageText = (
	token: string,
	chatId: string | number,
	messageId: number,
	text: string,
): Promise<TgResult> =>
	callTelegram(token, "editMessageText", {
		chat_id: chatId,
		message_id: messageId,
		text,
		parse_mode: "HTML",
		disable_web_page_preview: true,
	});
