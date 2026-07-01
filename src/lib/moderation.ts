/**
 * Shared moderation actions — the single audited code path behind both the
 * admin HTTP routes (src/routes/admin.ts) and the Telegram bot callbacks
 * (src/routes/telegram.ts). Keeping the orchestration here means an action
 * taken from a Telegram button writes the same audit row, fires the same
 * webhook, and busts the same cache as the equivalent dashboard click.
 *
 * Authorization is the caller's job: the admin routes gate on requireMod/
 * requireAdmin, and the Telegram route resolves the linked user + checks the
 * role before calling in. These functions assume a vetted actor and only take
 * the actor's id for the audit trail.
 */
import {
	adminInsertAudit,
	type CommentStatus,
	getComment,
	getUser,
	resolveReportsForComment,
	setUserBanned,
	updateCommentStatus,
} from "../db/queries";
import type { Bindings } from "../index";
import { bustTreeCache } from "./tree-cache";
import { fireWebhook, type WebhookEvent } from "./webhook";

/** waitUntil-capable context (Hono's c.executionCtx). */
type WaitUntilCtx = { waitUntil(p: Promise<unknown>): void } | undefined;

export type CommentAction = "approve" | "spam" | "delete" | "restore";

const STATUS_FOR: Record<CommentAction, CommentStatus> = {
	approve: "approved",
	restore: "approved",
	spam: "spam",
	delete: "deleted",
};

const WEBHOOK_FOR: Partial<Record<CommentStatus, WebhookEvent>> = {
	approved: "comment.approved",
	spam: "comment.spam",
	deleted: "comment.deleted",
};

/**
 * Apply a moderation status change to a comment: persist the status, write the
 * audit row, bust the cached first page, and fire the matching webhook.
 */
export const moderateComment = async (args: {
	env: Bindings;
	executionCtx: WaitUntilCtx;
	reqUrl: string;
	adminId: string;
	commentId: string;
	action: CommentAction;
	reason?: string | null;
}): Promise<
	| { ok: true; id: string; status: CommentStatus }
	| { ok: false; error: "not_found" }
> => {
	const { env, commentId, action } = args;
	const newStatus = STATUS_FOR[action];
	const existing = await getComment(env.DB, commentId);
	if (!existing) return { ok: false, error: "not_found" };
	await updateCommentStatus(env.DB, commentId, newStatus);
	await adminInsertAudit(env.DB, {
		admin_id: args.adminId,
		action,
		target_kind: "comment",
		target_id: commentId,
		reason: args.reason ?? null,
		meta: { prev_status: existing.status, new_status: newStatus },
	});
	await bustTreeCache(env, args.reqUrl, existing.post_slug);
	const event = WEBHOOK_FOR[newStatus];
	if (event) {
		fireWebhook(env, args.executionCtx, {
			event,
			comment_id: commentId,
			post_slug: existing.post_slug,
			user_id: existing.user_id,
			ts: Date.now(),
		});
	}
	return { ok: true, id: commentId, status: newStatus };
};

/**
 * Resolve (dismiss) all open reader reports on a comment. Does not change the
 * comment's own status — that's a separate moderation action.
 */
export const resolveReports = async (args: {
	env: Bindings;
	adminId: string;
	commentId: string;
}): Promise<
	| { ok: true; id: string; resolved: number }
	| { ok: false; error: "not_found" }
> => {
	const { env, commentId } = args;
	const existing = await getComment(env.DB, commentId);
	if (!existing) return { ok: false, error: "not_found" };
	const resolved = await resolveReportsForComment(env.DB, commentId);
	await adminInsertAudit(env.DB, {
		admin_id: args.adminId,
		action: "report.resolve",
		target_kind: "comment",
		target_id: commentId,
		meta: { resolved_count: resolved, post_slug: existing.post_slug },
	});
	return { ok: true, id: commentId, resolved };
};

/**
 * Ban or unban a user. `fromComment` records the comment that triggered a
 * one-click "ban author" so the action is traceable in the audit trail.
 */
export const banUser = async (args: {
	env: Bindings;
	adminId: string;
	userId: string;
	banned: boolean;
	fromComment?: string | null;
	reason?: string | null;
}): Promise<
	| { ok: true; id: string; banned: boolean }
	| { ok: false; error: "not_found" }
> => {
	const { env, userId, banned } = args;
	const target = await getUser(env.DB, userId);
	if (!target) return { ok: false, error: "not_found" };
	await setUserBanned(env.DB, userId, banned);
	const fromComment =
		typeof args.fromComment === "string" && args.fromComment.length > 0
			? args.fromComment
			: null;
	await adminInsertAudit(env.DB, {
		admin_id: args.adminId,
		action: banned ? "ban" : "unban",
		target_kind: "user",
		target_id: userId,
		reason: args.reason ?? null,
		meta: fromComment
			? { target_name: target.name, from_comment: fromComment }
			: { target_name: target.name },
	});
	return { ok: true, id: userId, banned };
};
