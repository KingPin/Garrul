import {
	type Comment,
	type CommentStatus,
	countOpenReportsByComment,
	getUser,
} from "../../db/queries";
import type { Bindings } from "../../index";
import type { OpAction } from "./codec";
import { relativeAge } from "./readouts";

export type OpButton = {
	action: OpAction;
	label: string;
	style: "primary" | "secondary" | "success" | "danger";
};

// All text is plain; each transport escapes for its own markup.
export type OpCard = {
	title: string;
	lines: string[];
	snippet?: string;
	doneBy?: string;
	adminUrl?: string;
	commentId: string;
	buttons: OpButton[][];
};

export const buttonsFor = (
	status: CommentStatus | null | undefined,
	opts: { reported: boolean; queue?: boolean; banLabel?: "ban" | "banr" },
): OpButton[][] => {
	// Unknown status falls back to the full triage: an idempotent Approve beats
	// hiding a needed action.
	let first: OpButton[];
	if (status === "spam") {
		first = [{ action: "restore", label: "✅ Not spam", style: "success" }];
	} else if (status === "approved") {
		first = [{ action: "spam", label: "🚫 Spam", style: "danger" }];
	} else {
		first = [
			{ action: "approve", label: "✅ Approve", style: "success" },
			{ action: "spam", label: "🚫 Spam", style: "danger" },
		];
	}
	const second: OpButton[] = [
		{ action: "delete", label: "🗑 Delete", style: "danger" },
		{ action: opts.banLabel ?? "ban", label: "⛔ Ban author", style: "danger" },
		{ action: "reply", label: "↩️ Reply", style: "primary" },
	];
	if (opts.reported) {
		second.push({
			action: "resolve",
			label: "📁 Resolve reports",
			style: "secondary",
		});
	}
	const rows = [first, second];
	if (opts.queue) {
		rows.push([{ action: "nx", label: "⏭ Next", style: "secondary" }]);
	}
	return rows;
};

export const renderQueueCard = async (
	env: Bindings,
	comment: Comment,
): Promise<OpCard> => {
	const [author, counts] = await Promise.all([
		getUser(env.DB, comment.user_id),
		countOpenReportsByComment(env.DB, [comment.id]),
	]);
	const openReports = counts[comment.id] ?? 0;
	return {
		title: "Pending comment",
		lines: [
			`Author: ${author?.name ?? "unknown"}`,
			`On: ${comment.post_slug} · ${relativeAge(comment.created_at, Date.now())} ago`,
		],
		snippet:
			comment.body_md.length > 200
				? `${comment.body_md.slice(0, 200)}…`
				: comment.body_md,
		...(env.PUBLIC_BASE_URL && {
			adminUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin/comments/${encodeURIComponent(comment.id)}`,
		}),
		commentId: comment.id,
		buttons: buttonsFor(comment.status, { reported: openReports > 0, queue: true }),
	};
};
