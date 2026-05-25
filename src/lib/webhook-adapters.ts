/**
 * Adapters that reshape the v1 WebhookPayload for non-generic
 * destinations. Today: Slack and Discord incoming webhooks.
 *
 * Architecture note: the generic adapter is a pure JSON.stringify of
 * the v1 payload. Slack/Discord need richer content (author name,
 * comment snippet) than the v1 contract carries, so each adapter does
 * its own DB lookup at render time. Once rendered, the resulting body
 * is stored verbatim on the webhook_deliveries row — retries resend
 * the same body, just with a fresh HMAC timestamp. We do NOT re-render
 * on retry: by the time the 6-hour retry fires, the comment may have
 * been edited or deleted, and we want the Slack/Discord channel to
 * reflect what *was true at the event time*, not the now-stale state.
 *
 * Security posture:
 *   - Snippets are truncated to platform limits BEFORE escaping, so a
 *     long body can't bust the platform's hard 2000/4000-char cap.
 *   - Mentions are neutralized so a comment body of "@everyone come
 *     read this" cannot ping a whole Slack workspace or Discord guild.
 *   - We send only `text` (Slack) / `content` (Discord) — no embeds,
 *     no blocks. Keeps the attack surface small; embeds have their
 *     own injection traps (markdown in titles, URL fields, etc.) we
 *     don't need yet.
 */
import { getComment, getPost, getUser } from "../db/queries";
import type { WebhookEvent, WebhookPayload } from "./webhook";

type WebhookAdapterDb = Pick<D1Database, "prepare">;

const EVENT_VERB: Record<WebhookEvent, string> = {
	"comment.posted": "New comment",
	"comment.edited": "Edited comment",
	"comment.deleted": "Comment deleted",
	"comment.approved": "Comment approved",
	"comment.spam": "Comment marked spam",
};

// Cap snippet length pre-escape so the worst-case escaped output still
// fits inside the platform body limit. 1500 raw chars + escape overhead
// stays under Discord's 2000 and Slack's 3000.
const SNIPPET_CAP = 1500;

type Ctx = {
	author: string;
	post_title: string;
	post_slug: string;
	snippet: string;
};

const truncate = (s: string, max: number): string =>
	s.length <= max ? s : `${s.slice(0, max)}…`;

const loadContext = async (
	db: WebhookAdapterDb,
	payload: WebhookPayload,
): Promise<Ctx> => {
	// All three lookups can fail (row deleted, DB hiccup) without
	// crashing the dispatch — the adapter degrades to ID-only.
	const [comment, user, post] = await Promise.all([
		getComment(db as D1Database, payload.comment_id).catch(() => null),
		getUser(db as D1Database, payload.user_id).catch(() => null),
		getPost(db as D1Database, payload.post_slug).catch(() => null),
	]);
	const author = user?.name ?? "anonymous";
	const post_slug = comment?.post_slug ?? payload.post_slug;
	const post_title = post?.title ?? post_slug;
	const raw = comment?.body_md ?? "(no body available)";
	const snippet = truncate(raw.replace(/\s+/g, " ").trim(), SNIPPET_CAP);
	return { author, post_slug, post_title, snippet };
};

// Slack mentions: @everyone, @here, @channel, <!everyone>, <!here>,
// <!channel>, <@U…>, <#C…>. Replace the `@` / `<!` with a literal
// equivalent that won't trigger a notification.
const escapeSlackMentions = (s: string): string =>
	s
		.replace(/@(everyone|here|channel)\b/gi, "@​$1")
		.replace(/<!(everyone|here|channel)>/gi, "<!​$1>")
		.replace(/<@([A-Z0-9]+)>/g, "<@​$1>")
		.replace(/<#([A-Z0-9]+)>/g, "<#​$1>");

// Slack body text needs &<> escaped per Slack's API docs.
const escapeSlackText = (s: string): string =>
	escapeSlackMentions(
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
	);

// Discord mentions: @everyone, @here, <@id>, <@!id>, <@&roleId>.
// Inserting a zero-width space breaks the trigger while keeping the
// text legible.
const escapeDiscordMentions = (s: string): string =>
	s
		.replace(/@(everyone|here)/gi, "@​$1")
		.replace(/<@([!&]?\d+)>/g, "<@​$1>");

export const renderSlackBody = async (
	db: WebhookAdapterDb,
	payload: WebhookPayload,
): Promise<string> => {
	const ctx = await loadContext(db, payload);
	const text =
		`*${EVENT_VERB[payload.event]}* by *${escapeSlackText(ctx.author)}* ` +
		`on \`${escapeSlackText(ctx.post_title)}\`\n` +
		`> ${escapeSlackText(ctx.snippet)}`;
	return JSON.stringify({ text });
};

export const renderDiscordBody = async (
	db: WebhookAdapterDb,
	payload: WebhookPayload,
): Promise<string> => {
	const ctx = await loadContext(db, payload);
	const content =
		`**${EVENT_VERB[payload.event]}** by **${escapeDiscordMentions(ctx.author)}** ` +
		`on \`${escapeDiscordMentions(ctx.post_title)}\`\n` +
		`> ${escapeDiscordMentions(ctx.snippet)}`;
	return JSON.stringify({ content });
};
