// Moderator reply, shared by the admin route and the operator bots. Moved out
// of routes/admin.ts verbatim; the route keeps request parsing and maps
// ReplyError back to its HTTP contract.

import {
	applyReplyVars,
	type ReplyVars,
} from "../../admin-ui/components/reply-vars";
import {
	adminInsertAudit,
	type Comment,
	enqueueNotificationsForPost,
	getComment,
	getPost,
	getSavedReply,
	getUser,
	insertComment,
	listSavedRepliesForUser,
	type SavedReply,
	type User,
} from "../../db/queries";
import type { Bindings } from "../../index";
import { log } from "../log";
import { CURRENT_RENDERER_VERSION, renderMarkdown, validateBody } from "../markdown";
import type { WaitUntilCtx } from "../moderation";
import { bustTreeCache } from "../tree-cache";
import { MAX_REPLY_DEPTH } from "../tree";
import { fireWebhook } from "../webhook";

export type ReplyError =
	| "comment_not_found"
	| "comment_deleted"
	| "thread_too_deep"
	| "body_required"
	| "body_too_long"
	| "saved_reply_not_visible";

/** Operator-facing refusal text shared by the Telegram and Discord bots (English by design). */
export const replyRefusalText = (e: ReplyError, max?: number): string =>
	e === "comment_not_found"
		? "That comment no longer exists."
		: e === "comment_deleted"
			? "That comment was deleted."
			: e === "thread_too_deep"
				? "That thread is too deep to reply to. Reply higher up from the dashboard."
				: e === "body_too_long"
					? `Reply too long (max ${max} characters).`
					: e === "body_required"
						? "Reply text is empty."
						: "That saved reply isn't available here.";

type ChatKind = { chat: "group" | "private" };

export const presetVisible = (
	preset: SavedReply,
	actorId: string,
	ctx: ChatKind,
): boolean =>
	preset.scope === "shared" ||
	(ctx.chat === "private" && preset.owner_id === actorId);

export const pickerPresets = async (
	db: D1Database,
	actorId: string,
	ctx: ChatKind,
): Promise<SavedReply[]> =>
	(await listSavedRepliesForUser(db, actorId)).filter((p) =>
		presetVisible(p, actorId, ctx),
	);

export const expandPreset = (body: string, vars: ReplyVars): string =>
	applyReplyVars(body, vars);

/** Same values the admin composer resolves client-side; missing stays undefined. */
export const presetVars = async (
	env: Bindings,
	commentId: string,
	actor: User,
): Promise<ReplyVars> => {
	const comment = await getComment(env.DB, commentId);
	const author = comment ? await getUser(env.DB, comment.user_id) : null;
	const post = comment ? await getPost(env.DB, comment.post_slug) : null;
	return {
		name: author?.name,
		post: comment ? post?.title || comment.post_slug : undefined,
		mod: actor.name,
	};
};

export const postModeratorReply = async (args: {
	env: Bindings;
	executionCtx?: WaitUntilCtx | undefined;
	reqUrl: string;
	actor: User;
	commentId: string;
	bodyMd: string;
	savedReplyId?: string | null | undefined;
	notify?: boolean | null | undefined;
	asStaff?: boolean | null | undefined;
}): Promise<
	| { ok: true; id: string; notified: boolean }
	| { ok: false; error: ReplyError; max?: number | undefined }
> => {
	const { env, actor } = args;
	const valid = validateBody(args.bodyMd);
	if (!valid.ok) {
		return valid.key === "err.body.too_long"
			? { ok: false, error: "body_too_long", max: valid.max }
			: { ok: false, error: "body_required" };
	}

	// Provenance has to be a reply the actor can see, or the audit row could
	// name someone else's private saved reply.
	let savedReplyId: string | null = null;
	if (args.savedReplyId != null) {
		const source = await getSavedReply(env.DB, args.savedReplyId);
		if (!source || (source.owner_id !== actor.id && source.scope !== "shared")) {
			return { ok: false, error: "saved_reply_not_visible" };
		}
		savedReplyId = source.id;
	}

	const target: Comment | null = await getComment(env.DB, args.commentId);
	if (!target) return { ok: false, error: "comment_not_found" };
	if (target.status === "deleted") return { ok: false, error: "comment_deleted" };
	// The nesting cap applies to moderators too: the O(N^2) tree-assembly cost
	// it guards doesn't care who created the chain.
	const depth = target.depth + 1;
	if (depth > MAX_REPLY_DEPTH) return { ok: false, error: "thread_too_deep" };

	const inserted = await insertComment(env.DB, {
		post_slug: target.post_slug,
		parent_id: target.id,
		user_id: actor.id,
		body_md: valid.body,
		body_html: renderMarkdown(valid.body),
		renderer_version: CURRENT_RENDERER_VERSION,
		status: "approved",
		ip_hash: null,
		user_agent: null,
		depth,
		as_staff: args.asStaff ?? true,
	});

	// Default on: followers of the thread hear about a mod reply the same way
	// they hear about a reader's reply.
	const notify = args.notify ?? true;
	await adminInsertAudit(env.DB, {
		admin_id: actor.id,
		action: "comment.reply",
		target_kind: "comment",
		target_id: inserted.id,
		meta: {
			from_saved_reply: savedReplyId != null,
			saved_reply_id: savedReplyId,
			parent_id: target.id,
			post_slug: target.post_slug,
			// The operator's choice, not a delivery count: the fan-out is deferred.
			notify_subscribers: notify,
		},
	});
	await bustTreeCache(env, args.reqUrl, target.post_slug);
	fireWebhook(env, args.executionCtx, {
		event: "comment.posted",
		comment_id: inserted.id,
		post_slug: target.post_slug,
		user_id: actor.id,
		ts: inserted.created_at,
	});

	if (notify) {
		const fanout = (async () => {
			// Skip the actor's own address: being emailed about your own comment
			// reads as a bug.
			const count = await enqueueNotificationsForPost(
				env.DB,
				target.post_slug,
				inserted.id,
				actor.email?.toLowerCase() ?? null,
			);
			log.info("notify.enqueued", { count, post_slug: target.post_slug });
		})();
		// Always wait for the enqueue without a waitUntil context, or the runtime
		// can cancel the orphan promise once the response settles.
		if (args.executionCtx) args.executionCtx.waitUntil(fanout);
		else await fanout;
	}

	return { ok: true, id: inserted.id, notified: notify };
};
