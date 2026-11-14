// Plain-data readouts shared by the Telegram and Discord bots. Each transport
// formats the result for its own markup.
import {
	adminOldestPending,
	adminOpenReportSummary,
	adminSpamRate,
	adminStats,
	type Comment,
	countOpenReportsByComment,
	getComment,
	getUser,
	type User,
} from "../../db/queries";
import type { Bindings } from "../../index";
import { banState } from "./actions";

export const relativeAge = (since: number, now: number): string => {
	const ms = Math.max(0, now - since);
	const mins = Math.floor(ms / 60000);
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h`;
	return `${Math.floor(hrs / 24)}d`;
};

export const readQueue = async (env: Bindings) => {
	const [stats, oldest, reports] = await Promise.all([
		adminStats(env.DB),
		adminOldestPending(env.DB),
		adminOpenReportSummary(env.DB),
	]);
	return {
		pending: stats.pending_comments,
		reported: reports.open,
		spam: stats.spam_comments,
		topFlagged: reports.top,
		oldest,
	};
};

export const readStats = async (env: Bindings) => {
	const [stats, spam7d] = await Promise.all([adminStats(env.DB), adminSpamRate(env.DB, 7)]);
	return {
		totalComments: stats.total_comments,
		pending: stats.pending_comments,
		totalUsers: stats.total_users,
		banned: stats.banned_users,
		spam7d: { spam: spam7d.spam, total: spam7d.total },
	};
};

export const readComment = async (
	env: Bindings,
	id: string,
): Promise<{ comment: Comment; authorName: string; openReports: number } | null> => {
	const comment = await getComment(env.DB, id);
	if (!comment) return null;
	const [author, counts] = await Promise.all([
		getUser(env.DB, comment.user_id),
		countOpenReportsByComment(env.DB, [id]),
	]);
	return { comment, authorName: author?.name ?? "unknown", openReports: counts[id] ?? 0 };
};

export const readUser = async (
	env: Bindings,
	id: string,
): Promise<{ user: User; ban: Awaited<ReturnType<typeof banState>> } | null> => {
	const user = await getUser(env.DB, id);
	if (!user) return null;
	return { user, ban: await banState(env.DB, user) };
};

export const collectDigest = async (env: Bindings, now: number) => {
	const [stats, reports, spam, oldest] = await Promise.all([
		adminStats(env.DB),
		adminOpenReportSummary(env.DB),
		adminSpamRate(env.DB, 7),
		adminOldestPending(env.DB),
	]);
	return {
		pending: stats.pending_comments,
		openReports: reports.open,
		topFlagged: reports.top,
		spamPct: spam.total > 0 ? Math.round((spam.spam / spam.total) * 1000) / 10 : 0,
		spamTotal: spam.total,
		banned: stats.banned_users,
		oldestAgeMs: oldest ? Math.max(0, now - oldest.created_at) : null,
	};
};
