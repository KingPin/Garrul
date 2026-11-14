import {
	adminAuditForTarget,
	type CommentStatus,
	countOpenReportsByComment,
	getComment,
	getUser,
	type User,
} from "../../db/queries";
import type { Bindings } from "../../index";
import { banUser, moderateComment, resolveReports, type WaitUntilCtx } from "../moderation";
import type { OpAction } from "./codec";
import type { OpActor } from "./identity";

export type OpCommand = OpAction | "unban";

const ADMIN_ONLY: ReadonlySet<OpCommand> = new Set(["ban", "banr", "bsub", "unban"]);

export const requiredRole = (a: OpCommand): "mod" | "admin" =>
	ADMIN_ONLY.has(a) ? "admin" : "mod";

export const hasRole = (actor: OpActor, need: "mod" | "admin"): boolean =>
	need === "mod" || actor.role === "admin";

export type ActionError =
	| "comment_not_found"
	| "target_is_staff"
	| "ban_refused"
	| "not_authorized";

// A Discord-role admin may not ban or unban Garrul staff; only a real Garrul
// admin can touch another mod/admin.
export const guardBanTarget = (actor: OpActor, target: User): boolean =>
	!(actor.adminViaDiscordRole && (target.role === "mod" || target.role === "admin"));

const VERB = {
	approve: "Approved",
	spam: "Marked spam",
	delete: "Deleted",
	restore: "Restored",
	resolve: "Reports resolved",
	ban: "Banned",
} as const;

export const runOpAction = async (args: {
	env: Bindings;
	executionCtx: WaitUntilCtx;
	actor: OpActor;
	action: keyof typeof VERB;
	commentId: string;
	reason?: string | null;
}): Promise<
	| { ok: true; status: CommentStatus; doneBy: string; reported: boolean }
	| { ok: false; error: ActionError }
> => {
	const { env, actor, action, commentId } = args;
	if (!hasRole(actor, requiredRole(action))) return { ok: false, error: "not_authorized" };
	const adminId = actor.user.id;

	if (action === "resolve") {
		const res = await resolveReports({ env, adminId, commentId });
		if (!res.ok) return { ok: false, error: "comment_not_found" };
	} else if (action === "ban") {
		const comment = await getComment(env.DB, commentId);
		if (!comment) return { ok: false, error: "comment_not_found" };
		const target = await getUser(env.DB, comment.user_id);
		if (!target) return { ok: false, error: "comment_not_found" };
		if (!guardBanTarget(actor, target)) return { ok: false, error: "target_is_staff" };
		const res = await banUser({
			env,
			adminId,
			userId: target.id,
			banned: true,
			fromComment: commentId,
			reason: args.reason ?? null,
		});
		if (!res.ok) return { ok: false, error: "ban_refused" };
	} else {
		const res = await moderateComment({
			env,
			executionCtx: args.executionCtx,
			reqUrl: env.PUBLIC_BASE_URL ?? "https://localhost",
			adminId,
			commentId,
			action,
			reason: args.reason ?? null,
		});
		if (!res.ok) return { ok: false, error: "comment_not_found" };
	}

	const [after, counts] = await Promise.all([
		getComment(env.DB, commentId),
		countOpenReportsByComment(env.DB, [commentId]),
	]);
	if (!after) return { ok: false, error: "comment_not_found" };
	return {
		ok: true,
		status: after.status,
		doneBy: `${VERB[action]} by ${actor.user.name}`,
		reported: (counts[commentId] ?? 0) > 0,
	};
};

export const unbanUser = async (args: {
	env: Bindings;
	actor: OpActor;
	userId: string;
}): Promise<
	{ ok: true } | { ok: false; error: "not_found" | "target_is_staff" | "not_authorized" }
> => {
	const { env, actor } = args;
	if (!hasRole(actor, requiredRole("unban"))) return { ok: false, error: "not_authorized" };
	const target = await getUser(env.DB, args.userId);
	if (!target) return { ok: false, error: "not_found" };
	if (!guardBanTarget(actor, target)) return { ok: false, error: "target_is_staff" };
	const res = await banUser({ env, adminId: actor.user.id, userId: args.userId, banned: false });
	return res.ok ? { ok: true } : { ok: false, error: "not_found" };
};

export const banState = async (
	db: D1Database,
	user: User,
): Promise<{ banned: false } | { banned: true; reason: string | null; purged: boolean }> => {
	if (!user.is_banned) return { banned: false };
	const rows = await adminAuditForTarget(db, "user", user.id, 20);
	const last = rows.find((r) => r.action === "ban" || r.action === "unban");
	// Banned with no ban row means the audit trail was purged.
	if (!last) return { banned: true, reason: null, purged: true };
	return { banned: true, reason: last.reason ?? null, purged: false };
};
