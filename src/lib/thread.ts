/**
 * Thread acceptance resolver.
 *
 * "Is this thread accepting new comments right now?" has four inputs that
 * stack in precedence order. Manual per-post close and the two auto-close
 * rules are not separate features — they're inputs to this one pure function,
 * which the POST handler consults before inserting a comment or reply and the
 * GET handler consults to tell the widget whether to show the form.
 *
 * Precedence (first match wins):
 *   1. global `comments_enabled` flag OFF      → closed everywhere
 *   2. per-post `posts.closed` set             → this thread frozen
 *   3. `auto_close_at` epoch reached           → instance-wide sunset passed
 *   4. `auto_close_days` elapsed since anchor  → thread aged out
 * Otherwise: open.
 *
 * Evaluated LAZILY at read/write time — there is no cron, no status flip, no
 * KV write. A thread "becomes" closed the moment a request observes the rule
 * crossing its threshold; nothing is persisted.
 *
 * Anchor for the age rule is `published_at` (the host page's real publish
 * time, supplied via data-published) falling back to `created_at`. Note that
 * `created_at` is when the FIRST COMMENT arrived (posts are created lazily on
 * first comment), not when the article was published — so the published_at
 * anchor is what makes day-based closing accurate. With neither a meaningful
 * anchor nor published_at, day-based close still works off created_at, just
 * measured from first-comment time.
 */
import type { Post } from "../db/queries";
import type { ResolvedFlags, ResolvedNumbers } from "./settings";

const DAY_MS = 86_400_000;

export type ThreadState = {
	/** Whether new comments/replies are accepted right now. */
	open: boolean;
	/** Why it's closed (for the widget's closed-state copy); undefined if open. */
	reason?: "comments_disabled" | "post_closed" | "sunset" | "aged_out";
};

/**
 * Pure resolver — no I/O, no clock of its own (caller passes `now`), so it's
 * trivially unit-testable. `now` is epoch ms.
 */
export const resolveThreadOpen = (
	post: Pick<Post, "closed" | "published_at" | "created_at">,
	flags: Pick<ResolvedFlags, "comments_enabled">,
	numbers: Pick<ResolvedNumbers, "auto_close_days" | "auto_close_at">,
	now: number,
): ThreadState => {
	// 1. Global kill switch.
	if (!flags.comments_enabled) {
		return { open: false, reason: "comments_disabled" };
	}

	// 2. Operator froze this one thread.
	if (post.closed) {
		return { open: false, reason: "post_closed" };
	}

	// 3. Instance-wide sunset date. 0 = disabled.
	if (numbers.auto_close_at > 0 && now >= numbers.auto_close_at) {
		return { open: false, reason: "sunset" };
	}

	// 4. Age-based close. 0 = disabled. Anchor on the host's real publish time,
	//    falling back to first-comment time.
	if (numbers.auto_close_days > 0) {
		const anchor = post.published_at ?? post.created_at;
		if (now >= anchor + numbers.auto_close_days * DAY_MS) {
			return { open: false, reason: "aged_out" };
		}
	}

	return { open: true };
};
