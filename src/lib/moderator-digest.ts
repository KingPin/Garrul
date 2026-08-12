/**
 * Moderator notification digest.
 *
 * A sibling to digest.ts, not a fifth responsibility inside it: that one answers
 * "what did readers of this thread miss", groups by subscriber and renders in
 * each subscriber's own locale. This one answers "what is waiting for you in the
 * queue", goes to a fixed operator list, and is English-only. The two share
 * `sendEmail`, `sanitizeForEmail` and the send-budget machinery; nothing else
 * about them is the same shape.
 *
 * Each cron tick:
 *   1. Take pending rows older than DEBOUNCE_MS, so a spam burst coalesces into
 *      one email instead of one per comment.
 *   2. Drop rows a moderator already handled — an approved comment or a deleted
 *      one needs no email — and mark them sent so they never come back.
 *   3. Render one digest, send it to every recipient, mark the batch sent.
 *
 * On send failure the rows stay pending and the next tick retries, matching
 * digest.ts. The failure that matters here is silence: an operator who never
 * configured email must get a no-op, not an error every five minutes.
 *
 * ENGLISH ONLY, deliberately. The subscriber digest reads `locale` off the
 * subscription row because the reader chose the language of the page they
 * subscribed from. A moderator did not choose anything — they are whoever
 * ADMIN_EMAILS names, and CLAUDE.md already fixes the admin UI and the Telegram
 * bot as English-only surfaces. This is the third. The strings are inline rather
 * than in src/i18n/en.ts for that reason: putting them in the table would invite
 * translations for a surface that has no locale to render them in.
 */
import {
	listPendingModeratorNotifications,
	markModeratorNotificationsSent,
	type PendingModeratorNotification,
} from "../db/queries";
import { sendEmail } from "./email";
import { reserveSend, type SendBudget } from "./email-budget";
import { log } from "./log";
import { sanitizeForEmail } from "./markdown";
import { loadFlags } from "./settings";
import type { Bindings } from "../index";

/** Same debounce as the subscriber digest — a burst is one email, not N. */
const DEBOUNCE_MS = 5 * 60 * 1000;

/**
 * Rows per tick. Lower than the subscriber digest's 50 because each row here is
 * a rendered comment body in one email rather than a whole email, and a digest
 * with 200 comments in it is not a thing anyone reads. The overflow is not lost:
 * it stays pending and goes out on the next tick, five minutes later.
 */
const MAX_ITEMS_PER_TICK = 25;

/**
 * The moderator mail ceiling. Its own scopes, seeded by migration 0021.
 *
 * Counted **per digest, not per recipient** — see the reservation in
 * `runModeratorDigest` for why the fan-out has to be indivisible.
 *
 * Fixed rather than operator-settable, unlike the confirmation caps. Those are
 * tunable because a busy post can legitimately push a real subscriber into the
 * 429; there is no equivalent here. Volume is already bounded by the cron
 * cadence (one digest per tick, whatever the queue depth) and the recipient list
 * is operator-controlled, so the only thing left for a cap to catch is a
 * runaway — a cron misfire, a retry loop — and for that a fixed ceiling well
 * above the ~288 ticks in a day is the right shape.
 *
 * The windows match email-budget.ts's for the same reasons documented there:
 * the short one kills a burst, the long one bounds a day's spend.
 */
const MODERATOR_SEND_BUDGETS: readonly SendBudget[] = [
	{ scope: "moderator:burst", max: 10, windowSec: 60 },
	{ scope: "moderator:daily", max: 500, windowSec: 86_400 },
];

const escapeHtml = (s: string | null | undefined): string => {
	if (s == null) return "";
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
};

/**
 * Split a comma-separated address list into recipients.
 *
 * The `includes("@")` filter is not address validation — it is a guard against
 * sending garbage to the provider. A list that picked up a stray word (a
 * trailing comma, a copied comment) would otherwise turn every send into a
 * Resend `validation_error` and take the real recipients down with it, since one
 * bad address fails the whole request.
 *
 * Lowercased and deduped so `Ops@x.com, ops@x.com` is one email, not two.
 */
const parseRecipients = (raw: string | undefined): string[] => {
	if (!raw) return [];
	const seen = new Set<string>();
	for (const part of raw.split(",")) {
		const addr = part.trim().toLowerCase();
		if (addr.includes("@")) seen.add(addr);
	}
	return Array.from(seen);
};

/**
 * Is this row still worth an email?
 *
 * The debounce window is five minutes, which is plenty of time for an operator
 * watching the queue to have already approved or deleted the comment. Mailing
 * them about it afterwards is how a notification channel teaches people to
 * ignore it.
 *
 * 'pending' rows survive only while the comment is still pending. 'reported'
 * rows survive unless the comment is gone — a report on a published comment is
 * the whole point of reporting, so `approved` is not a reason to drop it.
 */
const stillActionable = (row: PendingModeratorNotification): boolean =>
	row.reason === "pending"
		? row.status === "pending"
		: row.status !== "deleted";

/** Operator-facing label for the reason column. */
const reasonLabel = (reason: string): string =>
	reason === "reported" ? "Reported by a reader" : "Held for review";

const renderHtml = (params: {
	adminBase: string;
	items: PendingModeratorNotification[];
}): string => {
	const rows = params.items
		.map(
			(it) => `
<tr><td style="padding:12px 0;border-bottom:1px solid #e5e7eb;">
  <div style="font-size:13px;color:#6b7280;">
    ${escapeHtml(reasonLabel(it.reason))} · ${escapeHtml(it.author_name ?? "Anonymous")} ·
    <a href="${params.adminBase}/admin/comments/${encodeURIComponent(it.comment_id)}">review</a>
  </div>
  <div style="font-size:12px;color:#9ca3af;margin-top:2px;">${escapeHtml(it.post_slug)}</div>
  <div style="margin-top:6px;font-size:14px;color:#111827;">${sanitizeForEmail(it.body_html)}</div>
</td></tr>`,
		)
		.join("");
	const n = params.items.length;
	const heading =
		n === 1 ? "1 comment needs your review" : `${n} comments need your review`;
	return `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:24px;color:#111827;">
<h1 style="font-size:18px;margin:0 0 12px;">${escapeHtml(heading)}</h1>
<table style="width:100%;border-collapse:collapse;">${rows}</table>
<p style="margin-top:24px;font-size:12px;color:#6b7280;">
  <a href="${params.adminBase}/admin/queue" style="color:#6b7280;">Open the moderation queue</a>
  · Turn this off under Admin → Settings → Moderation.
</p>
</body></html>`;
};

/**
 * Send one moderation digest per cron tick.
 *
 * Every early return here is a silent no-op rather than a throw. Email is opt-in
 * for the many self-hosters who never configure it, and a scheduled pass that
 * threw once every five minutes on an instance that simply doesn't use the
 * feature would bury every real error in `wrangler tail`.
 */
export const runModeratorDigest = async (
	env: Bindings,
	now: number = Date.now(),
): Promise<void> => {
	if (env.EMAIL_PROVIDER !== "resend" || !env.RESEND_API_KEY) return;
	const from = env.EMAIL_FROM;
	const publicBase = env.PUBLIC_BASE_URL;
	if (!from || !publicBase) return;

	// The flag before the query: an instance with the feature off should cost one
	// cached settings read per tick, not a D1 scan. The enqueue paths are gated on
	// the same flag, so with it off there is nothing to find anyway — this is the
	// guard for an operator who turned it back off with a queue already built up.
	if (!(await loadFlags(env)).moderator_email_enabled) return;

	// ADMIN_EMAILS is the default because it is already exactly the set of people
	// who can act on what the email is about. MODERATOR_NOTIFY_EMAILS overrides it
	// for the operator whose alerts belong on a shared alias instead.
	const recipients = parseRecipients(
		env.MODERATOR_NOTIFY_EMAILS || env.ADMIN_EMAILS,
	);
	if (recipients.length === 0) return;

	const pending = await listPendingModeratorNotifications(
		env.DB,
		now - DEBOUNCE_MS,
		MAX_ITEMS_PER_TICK,
	);
	if (pending.length === 0) return;

	const ids = pending.map((p) => p.notification_id);
	const items = pending.filter(stillActionable);
	if (items.length === 0) {
		// Everything was handled inside the debounce window. Clear the rows so the
		// next tick doesn't rescan them forever.
		await markModeratorNotificationsSent(env.DB, ids);
		return;
	}

	const html = renderHtml({ adminBase: publicBase, items });
	const subject =
		items.length === 1
			? "1 comment needs review"
			: `${items.length} comments need review`;

	// One reservation for the whole fan-out, not one per recipient.
	//
	// The rows below are marked sent for *everyone* at once — they are a queue of
	// comments, not of deliveries — so the fan-out has to be indivisible or the
	// mark is a lie. Reserving per recipient made it divisible: a cap that ran out
	// midway through the list mailed the recipients before it, marked the batch
	// sent, and left everyone after it never hearing about those comments at all.
	//
	// Charging the budget per digest is also the honest accounting for what it is
	// bounding. The cap exists to catch a runaway — a cron misfire, a retry loop —
	// and a runaway is counted in ticks. The recipient list is operator-controlled
	// and small, so per-address charging only made the ceiling depend on how many
	// moderators there are, which is the one variable it has no reason to track.
	const reservation = await reserveSend(
		env.DB,
		MODERATOR_SEND_BUDGETS,
		now,
		"moderator",
	);
	// Nothing goes out and nothing is marked: the rows stay pending and the next
	// tick tries again, exactly as it does for a send failure.
	if (!reservation.ok) return;

	let anySent = false;
	let undelivered = 0;
	for (const to of recipients) {
		if (await sendEmail(env, { to, from, subject, html })) anySent = true;
		else undelivered++;
	}

	if (anySent) {
		// A single address failing is not a reason to hold the batch. The retry
		// would re-mail everyone who already got it, and against an address that
		// hard-bounces that repeats every tick forever. Name it instead, so the
		// operator can fix the address rather than watch duplicates arrive.
		if (undelivered > 0) {
			log.warn("moderator digest partially undelivered", {
				undelivered,
				recipients: recipients.length,
			});
		}
		await markModeratorNotificationsSent(env.DB, ids);
		return;
	}
	// Hand the slot back so a provider outage doesn't also spend the day's ceiling
	// — the same reason the subscribe path releases.
	await reservation.release();
	// Nothing went out. Leave every row pending for the next tick, and say so
	// once — a silent failure here means an operator believes their queue is
	// empty because nothing is telling them otherwise.
	log.warn("moderator digest sent nothing", { queued: items.length });
};
