// Discord helpers for the operator bot: interaction signature verification,
// a thin REST client and OpCard -> message rendering. No Discord SDK.
import type { Bindings } from "../index";
import { log } from "./log";
import type { OpCard } from "./opbot/cards";
import { SNOWFLAKE_RE } from "./opbot/codec";
import {
	buttonRows,
	escapeDiscordMentions,
	sanitizeDiscordDescription,
} from "./webhook-adapters";

// Re-exported so existing importers keep one Discord entry point.
export { buttonRows, SNOWFLAKE_RE };

export type DiscordInteraction = {
	id: string;
	type: 1 | 2 | 3 | 5;
	token: string;
	application_id: string;
	guild_id?: string;
	channel_id?: string;
	member?: {
		user: { id: string; username: string; global_name?: string | null };
		roles?: string[];
	};
	user?: { id: string };
	data?: {
		name?: string;
		options?: { name: string; value: string }[];
		custom_id?: string;
		values?: string[];
		components?: { components: { custom_id: string; value: string }[] }[];
	};
	message?: {
		id: string;
		channel_id: string;
		embeds?: unknown[];
		flags?: number;
	};
};

export const DISCORD_API = "https://discord.com/api/v10";
export const EPHEMERAL = 64;
export const TIMESTAMP_WINDOW_S = 300;

const API_TIMEOUT_MS = 5000;
const EMBED_COLOR = 0x5865f2;

export const discordEnabled = (
	env: Pick<Bindings, "DISCORD_BOT_TOKEN" | "DISCORD_PUBLIC_KEY">,
): boolean => Boolean(env.DISCORD_BOT_TOKEN && env.DISCORD_PUBLIC_KEY);

const hexToBytes = (hex: string, len: number): Uint8Array<ArrayBuffer> | null => {
	if (hex.length !== len * 2 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
	const out = new Uint8Array(new ArrayBuffer(len));
	for (let i = 0; i < len; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
};

/** Verify Discord's Ed25519 signature over `timestamp + rawBody`. Never throws. */
export const verifyDiscordRequest = async (
	publicKeyHex: string,
	signatureHex: string | undefined,
	timestamp: string | undefined,
	rawBody: string,
	nowMs = Date.now(),
): Promise<boolean> => {
	try {
		if (!signatureHex || !timestamp || !/^\d+$/.test(timestamp)) return false;
		if (Math.abs(nowMs / 1000 - Number(timestamp)) > TIMESTAMP_WINDOW_S) {
			return false;
		}
		const key = hexToBytes(publicKeyHex, 32);
		const sig = hexToBytes(signatureHex, 64);
		if (!key || !sig) return false;
		const pub = await crypto.subtle.importKey(
			"raw",
			key,
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		return await crypto.subtle.verify(
			{ name: "Ed25519" },
			pub,
			sig,
			new TextEncoder().encode(`${timestamp}${rawBody}`),
		);
	} catch {
		return false;
	}
};

export const discordApi = async (
	token: string,
	method: "GET" | "POST" | "PATCH" | "PUT",
	path: string,
	body?: unknown,
): Promise<{
	ok: boolean;
	status: number;
	json?: unknown;
	retryAfterMs?: number;
}> => {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
	try {
		const res = await fetch(`${DISCORD_API}${path}`, {
			method,
			headers: {
				authorization: `Bot ${token}`,
				"content-type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: ctrl.signal,
		});
		let json: unknown;
		try {
			json = await res.json();
		} catch {
			json = undefined;
		}
		const out: {
			ok: boolean;
			status: number;
			json?: unknown;
			retryAfterMs?: number;
		} = { ok: res.ok, status: res.status, json };
		if (res.status === 429) {
			const ra = Number(res.headers.get("retry-after"));
			if (Number.isFinite(ra) && ra >= 0) out.retryAfterMs = Math.ceil(ra * 1000);
		}
		if (!res.ok) log.warn("discord api non-2xx", { status: res.status, method });
		return out;
	} catch {
		log.warn("discord api request failed", { status: 0, method });
		return { ok: false, status: 0 };
	} finally {
		clearTimeout(timer);
	}
};

export const cardToMessage = (
	card: OpCard,
	extra: string[] = [],
): {
	content?: string;
	embeds: unknown[];
	components: unknown[];
	allowed_mentions: { parse: [] };
} => {
	const desc = [
		...card.lines.map(escapeDiscordMentions),
		...(card.snippet ? [`> ${sanitizeDiscordDescription(card.snippet)}`] : []),
	].join("\n");
	const embed: Record<string, unknown> = {
		title: escapeDiscordMentions(card.title).slice(0, 256),
		description: desc.slice(0, 4000),
		color: EMBED_COLOR,
	};
	if (card.adminUrl) embed.url = card.adminUrl;
	if (card.doneBy) {
		embed.fields = [
			{ name: "Done by", value: escapeDiscordMentions(card.doneBy).slice(0, 1024) },
		];
	}
	return {
		embeds: [embed],
		components: buttonRows(card.buttons, card.commentId, extra),
		allowed_mentions: { parse: [] },
	};
};

export const validateDiscordChannel = async (
	token: string,
	channelId: string,
	guildId: string,
): Promise<
	| { ok: true }
	| {
			ok: false;
			error:
				| "channel_not_found"
				| "channel_forbidden"
				| "channel_wrong_guild"
				| "channel_wrong_type";
	  }
> => {
	const r = await discordApi(token, "GET", `/channels/${channelId}`);
	if (r.status === 401 || r.status === 403) return { ok: false, error: "channel_forbidden" };
	if (!r.ok) return { ok: false, error: "channel_not_found" };
	const ch = r.json as { type?: number; guild_id?: string } | undefined;
	if (ch?.guild_id !== guildId) return { ok: false, error: "channel_wrong_guild" };
	if (ch.type !== 0 && ch.type !== 5) {
		return { ok: false, error: "channel_wrong_type" };
	}
	return { ok: true };
};
