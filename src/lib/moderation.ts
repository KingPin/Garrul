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
	countActiveAdmins,
	eraseUserData,
	getComment,
	getUser,
	listPostSlugsForUser,
	resolveReportsForComment,
	setUserBanned,
	updateCommentStatus,
	type UserErasureCounts,
} from "../db/queries";
import { t } from "../i18n";
import type { Bindings } from "../index";
import { revokeUserSessions } from "./session";
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
 *
 * Two bans are refused regardless of who asks, because both lock the
 * operator out of the instance they are operating: banning yourself, and
 * banning the last admin who can still sign in. A ban revokes every session
 * and `requireActiveUser` refuses the account from then on, so either one
 * leaves the admin UI with nobody able to open it and the only remedy the D1
 * CLI. The one-click "ban author" button makes both easy to reach — an admin
 * replying on their own post is one misclick from it — which is why this
 * lives in the shared function and not in one of its two callers. Unban is
 * never refused. Same shape as the role route's `cannot_change_own_role` /
 * `last_admin` guards, and like those, the count is deliberately not a
 * transaction: two admins banning each other in the same instant is a
 * narrow window whose worst case is a CLI recovery, not corrupt state.
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
	| { ok: false; error: "not_found" | "self" | "last_admin" }
> => {
	const { env, userId, banned } = args;
	const target = await getUser(env.DB, userId);
	if (!target) return { ok: false, error: "not_found" };
	if (banned && userId === args.adminId) return { ok: false, error: "self" };
	if (
		banned &&
		target.role === "admin" &&
		!target.is_banned &&
		(await countActiveAdmins(env.DB)) <= 1
	) {
		return { ok: false, error: "last_admin" };
	}
	await setUserBanned(env.DB, userId, banned);
	// A ban has to take their live sessions with it. `is_banned` alone doesn't:
	// readSession slides the 30-day TTL, so an active banned user's cookie stays
	// valid indefinitely. Not undone on unban — see revocationKey in session.ts.
	if (banned) await revokeUserSessions(env, userId);
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
		// No `target_name`, for the same reason as the role and subscription
		// actions: `target_id` identifies the user, the audit page joins a name at
		// read time, and a display name copied in here is personal data that
		// outlives the account — erasure anonymizes `users.name` but has never
		// reached the audit log. `ban` is the action most likely to be kept
		// longest, which makes it the worst place to leave a copy.
		meta: fromComment ? { from_comment: fromComment } : {},
	});
	return { ok: true, id: userId, banned };
};

/**
 * Erase a user's personal data. Irreversible, admin-only, audit-logged.
 *
 * Authorization is the caller's job as everywhere else in this module, but two
 * guards live here rather than in the route because they hold no matter who
 * calls in:
 *
 *   - **Not yourself.** Same reasoning as the role endpoint: it's a misclick
 *     away from an admin blanking their own account, and there is no undo.
 *   - **Not another admin.** Demote them first. An erasure clears
 *     `provider_id`, which is what their next login is matched on, so erasing a
 *     live admin locks that person out of the instance permanently and can strand
 *     an instance with zero reachable admins.
 *
 * The audit row deliberately records **counts, not values** — no name, no email,
 * no address. Writing the erased name into `audit_log.meta` would move the
 * personal data rather than remove it, and audit rows are the one thing an
 * operator is least likely to think to prune.
 */
export const eraseUser = async (args: {
	env: Bindings;
	reqUrl: string;
	adminId: string;
	userId: string;
	/** Also blank their comment bodies and mark them deleted. */
	redactBodies: boolean;
	reason?: string | null;
}): Promise<
	| { ok: true; id: string; counts: UserErasureCounts }
	| { ok: false; error: "not_found" | "cannot_erase_self" | "target_is_admin" }
> => {
	const { env, userId } = args;
	if (userId === args.adminId) return { ok: false, error: "cannot_erase_self" };
	const target = await getUser(env.DB, userId);
	if (!target) return { ok: false, error: "not_found" };
	if (target.role === "admin") return { ok: false, error: "target_is_admin" };

	// Slugs first: after the erasure `redactBodies` may have moved every comment
	// to `deleted`, and the rows are still there either way, but reading before
	// keeps this independent of what the erasure does to them.
	const slugs = await listPostSlugsForUser(env.DB, userId);
	const counts = await eraseUserData(env.DB, {
		id: userId,
		email: target.email,
		// English on purpose, and the one `t` call that should stay bound to the
		// module-level translator. This is written into `users.name` for good, so
		// localizing it would freeze whichever language the acting admin's browser
		// happened to negotiate into every reader's view of that row forever.
		placeholderName: t("ui.deleted"),
		redactBodies: args.redactBodies,
		now: Date.now(),
	});
	// Their sessions carry a user_id that now resolves to an emptied identity.
	// Revoke so nothing keeps acting as them, and so an open admin tab can't
	// re-populate anything.
	await revokeUserSessions(env, userId);
	await adminInsertAudit(env.DB, {
		admin_id: args.adminId,
		action: "user.erase",
		target_kind: "user",
		target_id: userId,
		reason: args.reason ?? null,
		meta: { redact_bodies: args.redactBodies, ...counts },
	});
	// The author name — and the bodies, if redacted — just changed on every
	// thread they appear in, and those first pages are served from the edge.
	for (const slug of slugs) {
		await bustTreeCache(env, args.reqUrl, slug);
	}
	return { ok: true, id: userId, counts };
};
