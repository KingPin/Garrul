/**
 * Adapters that reshape the v1 WebhookPayload for non-generic
 * destinations. Today: Slack and Discord incoming webhooks.
 *
 * Architecture note: the generic adapter is a pure JSON.stringify of
 * the v1 payload. Slack/Discord need richer content (author name,
 * comment snippet, navigation links) than the v1 contract carries, so
 * each adapter does its own DB lookup at render time. Once rendered, the
 * resulting body is stored verbatim on the webhook_deliveries row —
 * retries resend the same body, just with a fresh HMAC timestamp. We do
 * NOT re-render on retry: by the time the retry fires, the comment may
 * have been edited or deleted, and we want the Slack/Discord channel to
 * reflect what *was true at the event time*, not the now-stale state.
 * The links we embed (admin URL, page URL) are derived from the base URL
 * + comment id + post URL — all stable — so verbatim retry stays correct.
 *
 * Security posture:
 *   - Snippets are truncated to platform limits BEFORE escaping, so a
 *     long body can't bust the platform's hard 2000/4000-char cap.
 *   - Mentions are neutralized so a comment body of "@everyone come
 *     read this" cannot ping a whole Slack workspace or Discord guild.
 *   - Discord now renders an *embed* (nicer UI + clickable links). Embeds
 *     have injection traps the old plain-text path didn't: the embed
 *     `description` renders markdown, so a comment body of
 *     "[Win a prize](https://evil)" could become a clickable masked link.
 *     We defuse this by escaping `[`/`]` in the description (kills masked
 *     links and images) while leaving basic bold/italic to render. The
 *     embed `title` / `author.name` positions do NOT render markdown, and
 *     embeds never fire mentions, but we keep mention-neutralization as
 *     defense in depth. Every URL we place in a clickable position is
 *     either server-generated (admin link) or scheme-validated (page /
 *     avatar), never raw user input.
 */
import type { CommentStatus } from "../db/queries";
import { getComment, getPost, getUser } from "../db/queries";
import { moderationKeyboard } from "./telegram";
import type { WebhookEvent, WebhookPayload } from "./webhook";

type WebhookAdapterDb = Pick<D1Database, "prepare">;

/** Options threaded from the dispatcher into the rich adapters. */
export type AdapterOpts = {
	/** Instance base URL (PUBLIC_BASE_URL) for building admin links. */
	baseUrl?: string | undefined;
	/**
	 * Telegram destination chat id (numeric or `@channel`). The Telegram
	 * adapter embeds it in the rendered `sendMessage` body so the verbatim
	 * retry path re-sends to the same chat. Ignored by other adapters.
	 */
	chatId?: string | undefined;
};

const EVENT_VERB: Record<WebhookEvent, string> = {
	"comment.posted": "New comment",
	"comment.edited": "Edited comment",
	"comment.deleted": "Comment deleted",
	"comment.approved": "Comment approved",
	"comment.spam": "Comment marked spam",
	"comment.reported": "Comment reported",
};

// Discord embed accent color per event (decimal RGB).
const EVENT_COLOR: Record<WebhookEvent, number> = {
	"comment.posted": 0x5865f2, // blurple
	"comment.edited": 0x99aab5, // grey
	"comment.approved": 0x57f287, // green
	"comment.spam": 0xed4245, // red
	"comment.deleted": 0x992d22, // dark red
	"comment.reported": 0xfaa61a, // amber
};

// Cap snippet length pre-escape so the worst-case escaped output still
// fits inside the platform body limit. 1500 raw chars + escape overhead
// stays under Discord's 4096 embed-description and Slack's 3000.
const SNIPPET_CAP = 1500;
// Discord embed title / author.name hard cap is 256.
const EMBED_NAME_CAP = 256;

type Ctx = {
	author: string;
	post_title: string;
	post_slug: string;
	snippet: string;
	/** Admin deep link, or null when PUBLIC_BASE_URL is unset/invalid. */
	admin_url: string | null;
	/** Public page URL, or null when the post has no valid url. */
	page_url: string | null;
	/** Commenter avatar (provider), or null. https only. */
	avatar_url: string | null;
	/** Comment's current status, or null when the row was unavailable. */
	status: CommentStatus | null;
};

const truncate = (s: string, max: number): string =>
	s.length <= max ? s : `${s.slice(0, max)}…`;

// Parse + scheme-check a stored/derived URL before we place it in a
// clickable position. Mirrors the guard in src/routes/permalink.ts: the
// post url came from the embed widget's caller-supplied data-url, so we
// reject anything that isn't plain http(s) to avoid surfacing
// javascript:/data:/scheme-relative targets in a chat client.
const safeHttpUrl = (raw: string | null | undefined): string | null => {
	if (!raw) return null;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	return raw;
};

const loadContext = async (
	db: WebhookAdapterDb,
	payload: WebhookPayload,
	opts: AdapterOpts,
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

	// Admin deep link to the moderation detail page — only when we have a
	// valid base URL. Legacy operators without PUBLIC_BASE_URL simply don't
	// get this link.
	const base = safeHttpUrl(opts.baseUrl);
	const admin_url = base
		? `${base.replace(/\/$/, "")}/admin/comments/${encodeURIComponent(payload.comment_id)}`
		: null;
	// Public page link uses the stored post.url directly rather than the
	// /c/:id permalink: /c/:id 404s for pending/spam/deleted comments, and a
	// brand-new (pending) comment is exactly what a moderator gets pinged
	// about. Independent of PUBLIC_BASE_URL.
	const page_url = safeHttpUrl(post?.url);
	// Discord/Slack require https for displayed avatars.
	const avatar = user?.avatar_url ?? null;
	const avatar_url =
		avatar && safeHttpUrl(avatar)?.startsWith("https:") ? avatar : null;

	return {
		author,
		post_slug,
		post_title,
		snippet,
		admin_url,
		page_url,
		avatar_url,
		status: comment?.status ?? null,
	};
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
//
// Order matters: mention-neutralization MUST run before HTML escaping.
// Slack decodes &amp;/&lt;/&gt; before parsing mentions, so if we
// HTML-escape first, `<!channel>` becomes `&lt;!channel&gt;`, the
// mention regex finds nothing — and Slack happily decodes and pings
// the channel. Inserting the ZWSP into the raw form means the
// neutralizer survives the round trip.
const escapeSlackText = (s: string): string =>
	escapeSlackMentions(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

// A Slack link label lives inside <url|label>; the `|` would otherwise
// terminate the label. escapeSlackText already neutralizes <>& — swap the
// only remaining structural char for a visually identical box-drawing
// glyph so the label can't break out of the link.
const slackLinkLabel = (s: string): string =>
	escapeSlackText(s).replace(/\|/g, "│");

// A url is safe to drop into <url|label> only if it has no chars that
// would terminate the link span.
const slackSafeUrl = (url: string): boolean => !/[<>|]/.test(url);

// Discord mentions: @everyone, @here, <@id>, <@!id>, <@&roleId>.
// Inserting a zero-width space breaks the trigger while keeping the
// text legible. (Embeds don't fire mentions, but this is cheap defense
// in depth and keeps the rendered text tidy.)
const escapeDiscordMentions = (s: string): string =>
	s
		.replace(/@(everyone|here)/gi, "@​$1")
		.replace(/<@([!&]?\d+)>/g, "<@​$1>");

// The embed `description` renders markdown. Neutralize masked-link and
// image syntax by backslash-escaping the square brackets so a comment
// body of "[click me](https://evil)" can't become a clickable link.
// Basic emphasis is left to render for a nicer look.
//
// Backslashes MUST be doubled first: otherwise a body of "\[x](url)"
// would become "\\[x\](url)" — Discord renders "\\" as a literal
// backslash, leaving the "[" unescaped and the masked link live again.
// Escaping "\" → "\\" before the brackets closes that bypass.
const sanitizeDiscordDescription = (s: string): string =>
	escapeDiscordMentions(s)
		.replace(/\\/g, "\\\\")
		.replace(/[[\]]/g, "\\$&");

export const renderSlackBody = async (
	db: WebhookAdapterDb,
	payload: WebhookPayload,
	opts: AdapterOpts = {},
): Promise<string> => {
	const ctx = await loadContext(db, payload, opts);

	// Link the post title to the page when we can.
	const titleField =
		ctx.page_url && slackSafeUrl(ctx.page_url)
			? `<${ctx.page_url}|${slackLinkLabel(ctx.post_title)}>`
			: `\`${escapeSlackText(ctx.post_title)}\``;

	const links: string[] = [];
	if (ctx.admin_url && slackSafeUrl(ctx.admin_url)) {
		links.push(`<${ctx.admin_url}|🔍 Open in admin>`);
	}
	if (ctx.page_url && slackSafeUrl(ctx.page_url)) {
		links.push(`<${ctx.page_url}|🌐 View page>`);
	}

	let text =
		`*${EVENT_VERB[payload.event]}* by *${escapeSlackText(ctx.author)}* ` +
		`on ${titleField}\n` +
		`> ${escapeSlackText(ctx.snippet)}`;
	if (links.length > 0) text += `\n${links.join(" · ")}`;

	return JSON.stringify({ text });
};

export const renderDiscordBody = async (
	db: WebhookAdapterDb,
	payload: WebhookPayload,
	opts: AdapterOpts = {},
): Promise<string> => {
	const ctx = await loadContext(db, payload, opts);

	// Wrap the destination in <…> so Discord treats it as a literal URL:
	// a bare URL containing ")" (e.g. a "/wiki/Foo_(bar)" page link) would
	// otherwise terminate the markdown link early. The URLs are already
	// scheme-validated; this just hardens the markdown framing.
	const links: string[] = [];
	if (ctx.admin_url) links.push(`[🔍 Open in admin](<${ctx.admin_url}>)`);
	if (ctx.page_url) links.push(`[🌐 View page](<${ctx.page_url}>)`);

	const embed: Record<string, unknown> = {
		author: {
			name: truncate(escapeDiscordMentions(ctx.author), EMBED_NAME_CAP),
			...(ctx.avatar_url ? { icon_url: ctx.avatar_url } : {}),
		},
		title: truncate(ctx.post_title, EMBED_NAME_CAP),
		...(ctx.page_url ? { url: ctx.page_url } : {}),
		description: `> ${sanitizeDiscordDescription(ctx.snippet)}`,
		color: EVENT_COLOR[payload.event],
		footer: { text: "Garrul" },
		timestamp: new Date(payload.ts).toISOString(),
	};
	if (links.length > 0) {
		embed.fields = [{ name: "Links", value: links.join(" · ") }];
	}

	return JSON.stringify({ embeds: [embed] });
};

// ----------------------------- Telegram ------------------------------------
//
// Telegram messages use parse_mode=HTML, whose entity parser only honors a
// small tag allowlist (<b> <i> <a> <code> <blockquote> …). Any other "<"/">"
// in text is a parse error, so we HTML-escape all user-derived text. We only
// place server-generated or scheme-validated URLs in href positions. Telegram
// @mentions only notify members of the same chat (no @everyone broadcast like
// Slack/Discord), so escaping the angle brackets is the material defense.
// Quotes are escaped too because the same helper feeds href="..." attributes
// (see telegramLink) — an unescaped quote there breaks the attribute.
const escapeTelegramHtml = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

// Clip an already-HTML-escaped string to at most `max` chars without leaving a
// dangling partial entity. A naive slice can cut "&amp;" into "&am", which
// Telegram's HTML parser then rejects — so after slicing we drop any trailing
// "&…"-fragment that isn't terminated by ";". Complete entities (which end in
// ";") are preserved.
const clipEscaped = (s: string, max: number): string =>
	s.length <= max ? s : s.slice(0, max).replace(/&[#a-zA-Z0-9]*$/, "");

// Telegram's hard per-message cap is 4096 chars. The snippet is capped at
// SNIPPET_CAP (1500) pre-escape, but HTML-escaping can inflate it several-fold
// (every "<" → "&lt;" etc.), so the assembled message can still exceed the cap.
// renderTelegramBody budgets the snippet against this limit rather than blindly
// truncating the final string (a blind cut can split an entity or a tag).
const TELEGRAM_TEXT_CAP = 4096;

const telegramLink = (url: string, label: string): string =>
	`<a href="${escapeTelegramHtml(url)}">${escapeTelegramHtml(label)}</a>`;

export const renderTelegramBody = async (
	db: WebhookAdapterDb,
	payload: WebhookPayload,
	opts: AdapterOpts = {},
): Promise<string> => {
	const ctx = await loadContext(db, payload, opts);

	// Bound author/title the same way the Discord embed does, so the snippet is
	// the only field that can approach the per-message cap.
	const author = truncate(ctx.author, EMBED_NAME_CAP);
	const postTitle = truncate(ctx.post_title, EMBED_NAME_CAP);

	// page_url is already scheme-validated (safeHttpUrl) by loadContext, and the
	// href is HTML-attribute-escaped, so it's safe to link directly.
	const titleField = ctx.page_url
		? telegramLink(ctx.page_url, postTitle)
		: `<code>${escapeTelegramHtml(postTitle)}</code>`;

	const links: string[] = [];
	if (ctx.admin_url) links.push(telegramLink(ctx.admin_url, "🔍 Open in admin"));
	if (ctx.page_url) links.push(telegramLink(ctx.page_url, "🌐 View page"));

	const header =
		`<b>${escapeTelegramHtml(EVENT_VERB[payload.event])}</b> by ` +
		`<b>${escapeTelegramHtml(author)}</b> on ${titleField}\n`;
	const linkLine = links.length > 0 ? `\n${links.join(" · ")}` : "";

	// Budget the escaped snippet against the cap rather than blind-truncating the
	// final string. Keep the link line if everything fits; otherwise drop it to
	// give the snippet the room. clipEscaped guarantees the cut never lands
	// inside an HTML entity, which would make Telegram reject the whole message.
	const wrapper = "<blockquote></blockquote>".length;
	const escapedSnippet = escapeTelegramHtml(ctx.snippet);
	const roomWithLinks =
		TELEGRAM_TEXT_CAP - header.length - wrapper - linkLine.length;
	let snippet: string;
	let tail: string;
	if (escapedSnippet.length <= roomWithLinks) {
		snippet = escapedSnippet;
		tail = linkLine;
	} else {
		snippet = clipEscaped(
			escapedSnippet,
			Math.max(0, TELEGRAM_TEXT_CAP - header.length - wrapper),
		);
		tail = "";
	}
	const text = `${header}<blockquote>${snippet}</blockquote>${tail}`;

	const body: Record<string, unknown> = {
		text,
		parse_mode: "HTML",
		disable_web_page_preview: true,
		// Inline moderation buttons. A tap posts a callback_query to the inbound
		// /telegram route, which re-checks the linked operator's role before
		// acting. The keyboard is event-tailored (e.g. "Not spam" on a spam
		// alert, "Resolve reports" on a report).
		reply_markup: moderationKeyboard(
			payload.event,
			payload.comment_id,
			ctx.status,
		),
	};
	// chat_id is required by the Bot API. The dispatcher always supplies it for
	// telegram endpoints; guard so a misconfig surfaces as a Telegram 400 we
	// log rather than an undefined field.
	if (opts.chatId) body.chat_id = opts.chatId;

	return JSON.stringify(body);
};
