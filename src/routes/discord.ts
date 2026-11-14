/**
 * Inbound Discord route: the interactive side of the operator bot.
 *
 * Mounted top-level at `/discord`, outside `/api/*`, so it bypasses the CSRF
 * and session middleware. The only authentication is Discord's Ed25519
 * signature. Nothing touches D1 or KV before it verifies.
 *
 * Every interaction is answered synchronously (no defer in this build).
 */
import { Hono } from "hono";
import { getComment, getDiscordLinkByDiscordUser, getUser, nextPendingAfter, upsertDiscordLink } from "../db/queries";
import type { Bindings } from "../index";
import {
	buttonRows,
	type DiscordInteraction,
	discordEnabled,
	EPHEMERAL,
	verifyDiscordRequest,
	cardToMessage,
} from "../lib/discord";
import { log } from "../lib/log";
import type { WaitUntilCtx } from "../lib/moderation";
import {
	hasRole,
	OPBOT_RATE_LIMIT,
	requiredRole,
	runOpAction,
	unbanUser,
} from "../lib/opbot/actions";
import { buttonsFor, type OpCard, renderQueueCard } from "../lib/opbot/cards";
import { decodePayload, encodePayload } from "../lib/opbot/codec";
import { type OpActor, resolveDiscordActor } from "../lib/opbot/identity";
import { consumeLinkToken } from "../lib/opbot/link-token";
import { readComment, readQueue, readStats, readUser, relativeAge } from "../lib/opbot/readouts";
import { checkRateLimit } from "../lib/ratelimit";
import { loadDiscordSettings } from "../lib/settings";
import { escapeDiscordMentions } from "../lib/webhook-adapters";

export const discord = new Hono<{ Bindings: Bindings }>();

type Reply = Record<string, unknown>;
type Ctx = { env: Bindings; executionCtx: WaitUntilCtx };

const NO_MENTIONS = { parse: [] as [] };

const MSG = {
	slow: "Slow down — too many actions. Try again in a moment.",
	noAccess: "Your account doesn't have moderation access.",
	notLinked: "Link your account first with /link, or ask an admin for the mod role.",
	wrongGuild: "This bot only works in its configured server.",
	badCode: "That link code is invalid or expired.",
	gone: "That comment no longer exists.",
	staffUnban: "You can't unban a moderator or admin with a Discord role grant.",
	staffBan: "You can't ban a moderator or admin with a Discord role grant.",
	banRefused: "That ban was refused.",
	empty: "Queue is empty 🎉",
	noReply: "Reply from Discord is not available yet.",
	unknown: "Unknown action.",
} as const;

const ephemeral = (content: string): Reply => ({
	type: 4,
	data: { content, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS },
});

const update = (data: Reply): Reply => ({ type: 7, data: { ...data, allowed_mentions: NO_MENTIONS } });

const refusal = (reason: "not_linked" | "not_authorized" | "banned" | "wrong_guild"): Reply =>
	ephemeral(
		reason === "not_linked" ? MSG.notLinked : reason === "wrong_guild" ? MSG.wrongGuild : MSG.noAccess,
	);

const senderOf = (i: DiscordInteraction) => i.member?.user ?? null;
const senderId = (i: DiscordInteraction): string | null => senderOf(i)?.id ?? i.user?.id ?? null;
const displayName = (i: DiscordInteraction): string =>
	senderOf(i)?.global_name ?? senderOf(i)?.username ?? "unknown";

discord.post("/interactions", async (c) => {
	if (!discordEnabled(c.env)) return c.notFound();

	const raw = await c.req.text();
	const ok = await verifyDiscordRequest(
		c.env.DISCORD_PUBLIC_KEY as string,
		c.req.header("x-signature-ed25519"),
		c.req.header("x-signature-timestamp"),
		raw,
	);
	if (!ok) return c.json({ error: "invalid request signature" }, 401);

	let i: DiscordInteraction;
	try {
		i = JSON.parse(raw) as DiscordInteraction;
	} catch {
		return c.json({ error: "bad request" }, 400);
	}
	if (i.type === 1) return c.json({ type: 1 });

	const uid = senderId(i);
	if (uid) {
		const rl = await checkRateLimit(c.req.url, `dc:${uid}`, {
			scope: "discord",
			config: OPBOT_RATE_LIMIT,
			env: c.env,
		});
		if (!rl.ok) return c.json(ephemeral(MSG.slow));
	}

	try {
		return c.json(await dispatch({ env: c.env, executionCtx: c.executionCtx }, i));
	} catch (err) {
		log.error("discord.handler", { error: String(err) });
		return c.json(ephemeral("Something went wrong. Try again."));
	}
});

const dispatch = async (ctx: Ctx, i: DiscordInteraction): Promise<Reply> => {
	const uid = senderId(i);
	if (!uid) return refusal("wrong_guild");
	const cfg = await loadDiscordSettings(ctx.env);

	if (i.type === 2 && i.data?.name === "link") return handleLink(ctx, i, cfg.guildId, uid);

	const payload = i.type === 3 || i.type === 5 ? decodePayload(i.data?.custom_id) : null;
	if ((i.type === 3 || i.type === 5) && !payload) return ephemeral(MSG.unknown);

	// Opening the ban modal must stay within a fixed D1 read bound and write
	// nothing, so it skips full actor resolution. The submit re-authorizes.
	if (i.type === 3 && (payload?.action === "banr" || payload?.action === "ban")) {
		return openBanModal(ctx, i, cfg, payload.commentId, payload.extra[0] === "q");
	}

	const who = await resolveDiscordActor(ctx.env.DB, cfg, {
		guildId: i.guild_id,
		discordUserId: uid,
		displayName: displayName(i),
		roles: i.member?.roles,
	});
	if (!who.ok) return refusal(who.reason);
	const { actor } = who;

	if (i.type === 2) return handleCommand(ctx, i, actor);
	if (!payload) return ephemeral(MSG.unknown);
	if (!hasRole(actor, requiredRole(payload.action))) return ephemeral(MSG.noAccess);

	const q = payload.extra[0] === "q";
	const { action, commentId } = payload;
	if (i.type === 5) {
		if (action === "rsub") return ephemeral(MSG.noReply);
		if (action !== "bsub") return ephemeral(MSG.unknown);
		const input = i.data?.components?.flatMap((r) => r.components).find((x) => x.custom_id === "reason");
		const reason = input?.value?.trim().slice(0, 500) || null;
		return runAndRender(ctx, i, actor, "ban", commentId, q, reason);
	}
	switch (action) {
		case "reply":
		case "pick":
			return ephemeral(MSG.noReply);
		case "rv":
		case "nx": {
			const next = await nextPendingAfter(ctx.env.DB, action === "rv" ? null : commentId);
			if (!next) return update({ content: MSG.empty, embeds: [], components: [] });
			return update(await queueMessage(ctx.env, next.id));
		}
		case "approve":
		case "spam":
		case "delete":
		case "restore":
		case "resolve":
			return runAndRender(ctx, i, actor, action, commentId, q, null);
		default:
			return ephemeral(MSG.unknown);
	}
};

const openBanModal = async (
	ctx: Ctx,
	i: DiscordInteraction,
	cfg: { guildId: string; adminRoleId: string },
	commentId: string,
	q: boolean,
): Promise<Reply> => {
	const uid = senderId(i) as string;
	if (!cfg.guildId || i.guild_id !== cfg.guildId) return refusal("wrong_guild");
	let allowed = Boolean(cfg.adminRoleId) && (i.member?.roles ?? []).includes(cfg.adminRoleId);
	if (!allowed) {
		const link = await getDiscordLinkByDiscordUser(ctx.env.DB, uid);
		const user = link ? await getUser(ctx.env.DB, link.user_id) : null;
		allowed = Boolean(user && !user.erased_at && !user.is_banned && user.role === "admin");
	}
	if (!allowed) return ephemeral(MSG.noAccess);
	return {
		type: 9,
		data: {
			custom_id: encodePayload("discord", "bsub", commentId, q ? ["q"] : []),
			title: "Ban author",
			components: [
				{
					type: 1,
					components: [
						{
							type: 4,
							custom_id: "reason",
							style: 2,
							label: "Reason (optional)",
							required: false,
							max_length: 500,
						},
					],
				},
			],
		},
	};
};

const queueMessage = async (env: Bindings, commentId: string, doneBy?: string) => {
	const comment = await getComment(env.DB, commentId);
	if (!comment) return { content: MSG.gone, embeds: [], components: [] };
	const card = await renderQueueCard(env, comment);
	// Discord bans through the reason modal, so the queue card swaps the action.
	const swapped: OpCard = {
		...card,
		...(doneBy && { doneBy }),
		buttons: card.buttons.map((row) => row.map((b) => (b.action === "ban" ? { ...b, action: "banr" as const } : b))),
	};
	return { content: "", ...cardToMessage(swapped, ["q"]) };
};

const runAndRender = async (
	ctx: Ctx,
	i: DiscordInteraction,
	actor: OpActor,
	action: "approve" | "spam" | "delete" | "restore" | "resolve" | "ban",
	commentId: string,
	q: boolean,
	reason: string | null,
): Promise<Reply> => {
	const res = await runOpAction({
		env: ctx.env,
		executionCtx: ctx.executionCtx,
		actor,
		action,
		commentId,
		reason,
	});
	if (!res.ok) {
		return ephemeral(
			res.error === "comment_not_found"
				? MSG.gone
				: res.error === "target_is_staff"
					? MSG.staffBan
					: res.error === "ban_refused"
						? MSG.banRefused
						: MSG.noAccess,
		);
	}
	if (q) return update(await queueMessage(ctx.env, commentId, res.doneBy));
	return update({
		content: escapeDiscordMentions(res.doneBy),
		embeds: i.message?.embeds ?? [],
		components: buttonRows(
			buttonsFor(res.status, { reported: res.reported, banLabel: "banr" }),
			commentId,
		),
	});
};

const handleLink = async (ctx: Ctx, i: DiscordInteraction, guildId: string, uid: string): Promise<Reply> => {
	if (!guildId || i.guild_id !== guildId) return refusal("wrong_guild");
	const code = i.data?.options?.find((o) => o.name === "code")?.value ?? "";
	const userId = await consumeLinkToken(ctx.env.OAUTH_STATE, "dc", code.trim());
	const user = userId ? await getUser(ctx.env.DB, userId) : null;
	if (!user) return ephemeral(MSG.badCode);
	await upsertDiscordLink(ctx.env.DB, { discord_user_id: uid, user_id: user.id });
	return ephemeral(`Linked to ${escapeDiscordMentions(user.name)}.`);
};

const adminUrl = (env: Bindings, id: string): string | null =>
	env.PUBLIC_BASE_URL
		? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin/comments/${encodeURIComponent(id)}`
		: null;

const handleCommand = async (ctx: Ctx, i: DiscordInteraction, actor: OpActor): Promise<Reply> => {
	const { env } = ctx;
	const arg = (i.data?.options?.find((o) => o.name === "id")?.value ?? "").trim();
	const esc = escapeDiscordMentions;
	switch (i.data?.name) {
		case "queue": {
			const r = await readQueue(env);
			const lines = [
				"**Moderation queue**",
				`⏳ Pending: **${r.pending}**`,
				`🚩 Reported: **${r.reported}**`,
				`🚫 Spam: **${r.spam}**`,
			];
			if (r.topFlagged) lines.push(`Most flagged: ${esc(r.topFlagged.slug)} (${r.topFlagged.count})`);
			if (r.oldest) {
				const url = adminUrl(env, r.oldest.id);
				lines.push(`Oldest pending: ${relativeAge(r.oldest.created_at, Date.now())} ago${url ? ` — ${url}` : ""}`);
			}
			const reply = ephemeral(lines.join("\n"));
			(reply.data as Reply).components = [
				{
					type: 1,
					components: [
						{ type: 2, style: 1, label: "Review ▶", custom_id: encodePayload("discord", "rv", "-", ["q"]) },
					],
				},
			];
			return reply;
		}
		case "stats": {
			const s = await readStats(env);
			const pct = s.spam7d.total > 0 ? Math.round((s.spam7d.spam / s.spam7d.total) * 100) : 0;
			return ephemeral(
				[
					"**Stats**",
					`💬 Comments: **${s.totalComments}** (${s.pending} pending)`,
					`👥 Users: **${s.totalUsers}** (${s.banned} banned)`,
					`🚫 Spam rate (7d): **${pct}%** (${s.spam7d.spam}/${s.spam7d.total})`,
				].join("\n"),
			);
		}
		case "comment": {
			if (!arg) return ephemeral("Usage: /comment <id>");
			const r = await readComment(env, arg);
			if (!r) return ephemeral(MSG.gone);
			const { comment, authorName, openReports } = r;
			const snippet = comment.body_md.length > 200 ? `${comment.body_md.slice(0, 200)}…` : comment.body_md;
			const url = adminUrl(env, arg);
			return ephemeral(
				[
					`**Comment** ${esc(arg)}`,
					`Status: **${comment.status}**${openReports > 0 ? ` · ${openReports} open report(s)` : ""}`,
					`Author: ${esc(authorName)}`,
					`On: ${esc(comment.post_slug)} · ${relativeAge(comment.created_at, Date.now())} ago`,
					`> ${esc(snippet).replace(/\n/g, "\n> ")}`,
					...(url ? [url] : []),
				].join("\n"),
			);
		}
		case "user": {
			if (!arg) return ephemeral("Usage: /user <id>");
			const r = await readUser(env, arg);
			if (!r) return ephemeral("No such user.");
			const { user, ban } = r;
			return ephemeral(
				[
					`**User** ${esc(arg)}`,
					`Name: ${esc(user.name)}`,
					`Role: **${user.role}**`,
					`Provider: ${esc(user.provider)}`,
					`Joined: ${relativeAge(user.created_at, Date.now())} ago`,
					!ban.banned
						? "Not banned"
						: ban.purged
							? "Banned — reason no longer available"
							: ban.reason
								? `Banned — ${esc(ban.reason)}`
								: "Banned — no reason given",
				].join("\n"),
			);
		}
		case "unban": {
			if (!arg) return ephemeral("Usage: /unban <id>");
			const res = await unbanUser({ env, actor, userId: arg });
			if (res.ok) return ephemeral("Unbanned.");
			return ephemeral(
				res.error === "not_found"
					? "No such user."
					: res.error === "target_is_staff"
						? MSG.staffUnban
						: MSG.noAccess,
			);
		}
		default:
			return ephemeral(MSG.unknown);
	}
};

