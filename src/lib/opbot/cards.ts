import type { CommentStatus } from "../../db/queries";
import type { OpAction } from "./codec";

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
