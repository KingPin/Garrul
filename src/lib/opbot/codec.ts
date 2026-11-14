// Shared payload codec for operator-bot buttons (Telegram callback_data and
// Discord custom_id). Format: "g:<action>:<commentId>[:<extra>...]".
// `banr` = ban with reason prompt/modal; `reply` = open picker; `sr` =
// Telegram saved reply chosen; `rc` = Telegram custom reply prompt; `pick` =
// Discord picker select; `rsub` / `bsub` = Discord reply / ban modal submit;
// `rv` = start queue review (comment id "-"); `nx` = next/skip in queue.

export const OP_ACTIONS = [
	"approve",
	"spam",
	"delete",
	"restore",
	"ban",
	"banr",
	"resolve",
	"reply",
	"sr",
	"rc",
	"pick",
	"rsub",
	"bsub",
	"rv",
	"nx",
] as const;

export type OpAction = (typeof OP_ACTIONS)[number];

export type Transport = "telegram" | "discord";

// Telegram counts UTF-8 bytes, Discord counts characters.
export const PAYLOAD_MAX: Record<Transport, number> = {
	telegram: 64,
	discord: 100,
};

const PREFIX = "g";

const size = (t: Transport, s: string): number =>
	t === "telegram" ? new TextEncoder().encode(s).length : s.length;

export const encodePayload = (
	t: Transport,
	action: OpAction,
	commentId: string,
	extra: string[] = [],
): string => {
	const out = [PREFIX, action, commentId, ...extra].join(":");
	if (size(t, out) > PAYLOAD_MAX[t]) {
		throw new RangeError(`${t} payload exceeds ${PAYLOAD_MAX[t]}: ${out}`);
	}
	return out;
};

export const decodePayload = (
	data: string | undefined,
): { action: OpAction; commentId: string; extra: string[] } | null => {
	if (typeof data !== "string") return null;
	const [prefix, action, commentId, ...extra] = data.split(":");
	if (prefix !== PREFIX) return null;
	if (!OP_ACTIONS.includes(action as OpAction)) return null;
	if (!commentId) return null;
	if ((action === "rv") !== (commentId === "-")) return null;
	return { action: action as OpAction, commentId, extra };
};
