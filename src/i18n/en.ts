export const en = {
	// Validation / API errors
	"err.body.required": "Comment body is required.",
	"err.body.too_long": "Comment is too long (max {max} characters).",
	"err.post.required": "Missing post identifier.",
	"err.post.invalid": "Invalid post identifier.",
	"err.parent.not_found": "Parent comment not found.",
	"err.parent.different_post": "Parent comment belongs to a different post.",
	"err.name.required": "A display name is required.",
	"err.name.too_long": "Display name is too long (max {max} characters).",
	"err.email.invalid": "Email address is not valid.",
	"err.turnstile.required": "Spam check failed. Refresh and try again.",
	"err.turnstile.invalid": "Spam check failed. Refresh and try again.",
	"err.ratelimit": "Too many comments — slow down and try again in a moment.",
	"err.honeypot": "Comment rejected.",
	"err.origin.forbidden": "Request blocked: origin not allowed.",
	"err.session.required": "Sign in or set a name to comment.",
	"err.session.expired": "Your session expired. Refresh and try again.",
	"err.edit.window_expired": "Edit window has expired.",
	"err.edit.not_author": "You can only edit your own comments.",
	"err.delete.not_author": "You can only delete your own comments.",
	"err.not_found": "Not found.",
	"err.banned": "Your account is banned.",
	"err.thread_closed": "Comments are closed on this post.",
	"err.internal": "Something went wrong. Try again.",

	// UI strings (used later by widget templates)
	"ui.placeholder.comment": "Add a comment…",
	"ui.placeholder.name": "Your name",
	"ui.placeholder.email": "Email (optional, never shown)",
	"ui.submit": "Post",
	"ui.cancel": "Cancel",
	"ui.edit": "Edit",
	"ui.delete": "Delete",
	"ui.reply": "Reply",
	"ui.subscribe": "Notify me of replies",
	"ui.posted_just_now": "just now",
	"ui.deleted": "[deleted]",
	"ui.deleted_by_mod": "[removed by a moderator]",
	"ui.pending": "Pending approval",
	"ui.edited_suffix": "(edited)",
	"ui.verified": "verified",
	"ui.subscribe.pending": "Check your inbox to confirm your subscription.",
	"ui.subscribe.confirmed": "Subscription confirmed.",

	// Subscription confirmation email
	"email.confirm.subject": "Confirm your subscription to comments on {title}",
	"email.confirm.preheader":
		"Click the link inside to start receiving reply notifications.",

	// Telegram operator bot (admin-facing; shown in the bot chat, not in logs)
	"telegram.not_linked":
		"This Telegram account isn't linked. Open the admin panel → Telegram to link it.",
	"telegram.not_authorized": "Your account doesn't have moderation access.",
	"telegram.unknown_action": "Unknown or expired action.",
	"telegram.comment_not_found": "That comment no longer exists.",
	"telegram.action_applied": "✓ {action} applied",
	"telegram.reports_resolved": "✓ Resolved {count} report(s)",
	"telegram.author_banned": "✓ Banned the comment author",
	"telegram.link_ok":
		"✅ Linked to {name}. You'll get operator notifications and can moderate from here.",
	"telegram.link_invalid":
		"That link code is invalid or expired. Generate a fresh one in the admin panel.",
	"telegram.link_user_missing": "Linking failed: that operator account no longer exists.",
	"telegram.ratelimited": "Slow down a moment and try again.",
	"telegram.start_help":
		"Send /start &lt;code&gt; with a code from the admin Telegram page to link your operator account.",
} as const;

export type StringKey = keyof typeof en;
