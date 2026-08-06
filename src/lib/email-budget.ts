/**
 * A non-racy global ceiling on outbound confirmation email, counted in D1.
 *
 * The problem (issue #64). POST /api/v1/subscriptions sends one confirmation
 * email per accepted request. Two controls sat in front of it and neither
 * bounded an attacker who cycles addresses:
 *
 *   - `PENDING_PER_EMAIL_CAP` is atomic but keyed on the address, so
 *     a@x.com / b@x.com / c@x.com each get their own budget.
 *   - The IP-keyed rate limiter is the only other gate, and on the default
 *     Cache API backend its read-modify-write is non-atomic *and* its write is
 *     a full overwrite. N concurrent requests from one identity therefore
 *     sustain roughly N x the configured cap indefinitely — a sustained
 *     multiplier, not a one-off burst. tests/ratelimit.test.ts pins exactly
 *     that, and docs/ANTISPAM.md § "Rate-limit accuracy" documents it.
 *
 * Binding `RATE_LIMIT_DO` makes the limiter atomic, but it is opt-in and
 * commented out in wrangler.example.toml, so it is not the default posture.
 * This module is the control that holds without it.
 *
 * Why D1. The Cache API has no compare-and-swap, which is the root of the
 * limiter's race. D1 does not need one: a single UPDATE statement is atomic, so
 * putting the cap in the statement's own WHERE clause makes check-and-increment
 * indivisible. Concurrency cannot multiply it — the losing writers change zero
 * rows and are told so.
 *
 * Why a counter row instead of a windowed COUNT(*) over `subscriptions`:
 * 0017_subscriptions_email_index.sql notes D1 bills rows *read* and that this
 * unauthenticated path is "the scan an attacker gets to trigger for free". A
 * COUNT(*) grows more expensive precisely under attack; this is O(1) forever.
 * It also counts the right thing — `subscriptions.created_at` is untouched by
 * `upsertSubscription`'s ON CONFLICT branch, so a row-based window would miss
 * re-sends to an existing pending row entirely.
 *
 * Why global rather than per-identity. Every per-identity key this endpoint has
 * is either racy (the limiter) or attacker-controlled: `email` is arbitrary and
 * `post_slug` is never validated against `posts`. A global ceiling is the one
 * bound none of those bypasses reach. The cost is real and documented in
 * docs/ANTISPAM.md: an attacker can spend a window and deny *new* subscriptions
 * until it rolls. That is strictly better than unbounded billable mail plus a
 * sending domain accumulating bounce reputation, and it does not touch existing
 * confirmed subscribers — only confirmation mail passes through here.
 */
import { log } from "./log";

export type SendBudget = {
	/** Primary key in `email_send_budget`; seeded by migration 0018. */
	scope: string;
	/** Sends allowed per window. */
	max: number;
	/** Fixed-window length in seconds. */
	windowSec: number;
};

/**
 * The live confirmation-email budgets. Both must grant for a send to proceed.
 *
 * Two windows for the same reason the rate limiter has two: the short one kills
 * the concurrency burst that the racy limiter allows, and the long one bounds
 * total spend and bounce-reputation damage over a day. A single window would
 * force a choice between those.
 *
 * These are deliberately far above any plausible organic signup rate for a
 * self-hosted blog — the intent is that only abuse ever reaches them. They are
 * module constants rather than `settings.ts` entries because every NUMBERS
 * entry there needs a new `keyof Bindings` field, which pulls in
 * `parseBindings`, tests/config-registry.test.ts and a release-manifest regen.
 * Wiring them to settings so operators on a small mail plan can lower them
 * without a redeploy is worthwhile follow-up, not part of the fix.
 *
 * `reserveSend` logs at warn when a budget denies, so an operator who does out-
 * grow these finds out from `wrangler tail` rather than from silence.
 */
export const CONFIRM_SEND_BUDGETS: readonly SendBudget[] = [
	{ scope: "confirm:burst", max: 20, windowSec: 60 },
	{ scope: "confirm:daily", max: 200, windowSec: 86_400 },
];

/** The subset of `Bindings` this module needs — structural so tests can pass a
 *  plain object and there is no import cycle back to the app root. */
export type EmailBudgetDb = Pick<D1Database, "prepare">;

/**
 * Reserve one send against a single budget.
 *
 * The whole decision is this one statement. `window_start <= cutoff` means the
 * window has expired, in which case the statement rolls it forward and restarts
 * the count at 1; otherwise it increments, but the WHERE clause only matches
 * while `sent < max`. SQLite evaluates every SET expression against the
 * pre-update row, so both branches read a consistent `window_start`.
 *
 * `meta.changes === 1` means this caller owns a slot. `0` means either the cap
 * is spent or the row is missing; the caller distinguishes those.
 */
const reserveOne = async (
	db: EmailBudgetDb,
	budget: SendBudget,
	now: number,
): Promise<boolean> => {
	const cutoff = now - budget.windowSec * 1000;
	const res = await db
		.prepare(
			`UPDATE email_send_budget
			    SET sent         = CASE WHEN window_start <= ? THEN 1 ELSE sent + 1 END,
			        window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
			  WHERE scope = ?
			    AND (window_start <= ? OR sent < ?)`,
		)
		.bind(cutoff, cutoff, now, budget.scope, cutoff, budget.max)
		.run();
	return (res.meta?.changes ?? 0) > 0;
};

/**
 * Release a slot reserved by `reserveOne`.
 *
 * Called when the reservation turned out not to be spent — the upsert found an
 * already-confirmed row, so no mail went out. Without this, a reader
 * re-subscribing to a thread they already confirmed would silently burn global
 * budget for an email that was never sent.
 *
 * `window_start <= reservedAt` is the guard that makes this safe: if the window
 * has rolled since we reserved, its `window_start` is later than our timestamp
 * and we correctly decline to decrement a window we never contributed to.
 * `sent > 0` keeps the counter non-negative regardless.
 */
const releaseOne = async (
	db: EmailBudgetDb,
	budget: SendBudget,
	reservedAt: number,
): Promise<void> => {
	await db
		.prepare(
			`UPDATE email_send_budget
			    SET sent = sent - 1
			  WHERE scope = ? AND sent > 0 AND window_start <= ?`,
		)
		.bind(budget.scope, reservedAt)
		.run();
};

/** Does this budget's row exist? Only consulted when a reserve changed zero
 *  rows, so it costs a single-row read on the denied path and nothing on the
 *  happy path. */
const scopeExists = async (
	db: EmailBudgetDb,
	scope: string,
): Promise<boolean> => {
	const row = await db
		.prepare(`SELECT 1 AS present FROM email_send_budget WHERE scope = ?`)
		.bind(scope)
		.first<{ present: number }>();
	return row != null;
};

export type Reservation = {
	/** Whether the send may proceed. */
	ok: boolean;
	/** Why it may not, for logging and the response body. `null` when ok. */
	reason: string | null;
	/** Release the reservation because no mail was sent. No-op when `!ok`. */
	release: () => Promise<void>;
};

const ALLOW: Reservation = {
	ok: true,
	reason: null,
	release: async () => {},
};

/**
 * Reserve one confirmation email against every configured budget.
 *
 * Fails OPEN on infrastructure trouble — a D1 error, or a budget row that is
 * missing because the migration did not land. The rate limiter makes the same
 * call for the same reason (see its `fails open and flags degraded` test): a
 * subscribe endpoint that refuses everyone because a table is missing is a
 * worse outcome than one that briefly counts nothing.
 *
 * Budgets are reserved in order and are not jointly atomic: if the burst budget
 * grants and the daily one denies, the burst counter keeps that one increment.
 * That over-counts by at most one per denied request and only ever makes the
 * limit *stricter*, which is the safe direction — the same trade-off the rate
 * limiter makes when it reads both windows before writing either.
 *
 * Releasing the earlier grant on that path would remove even the over-count,
 * and is deliberately not done: denials are the attacker-triggered case, so it
 * would add a D1 *write* to precisely the path an attacker controls the volume
 * of. Paying one stale slot per denial is cheaper than that.
 */
export const reserveConfirmSend = async (
	db: EmailBudgetDb,
	budgets: readonly SendBudget[] = CONFIRM_SEND_BUDGETS,
	now: number = Date.now(),
): Promise<Reservation> => {
	const held: SendBudget[] = [];
	try {
		for (const budget of budgets) {
			if (await reserveOne(db, budget, now)) {
				held.push(budget);
				continue;
			}
			// Zero rows changed: the cap is spent, or the row was never seeded.
			if (!(await scopeExists(db, budget.scope))) {
				log.warn("email budget scope missing, failing open", {
					scope: budget.scope,
				});
				continue;
			}
			log.warn("confirmation email budget exhausted", {
				scope: budget.scope,
				max: budget.max,
				window_sec: budget.windowSec,
			});
			return { ok: false, reason: budget.scope, release: async () => {} };
		}
	} catch (err) {
		log.warn("email budget unavailable, failing open", {
			error: (err as Error).message,
		});
		return ALLOW;
	}

	return {
		ok: true,
		reason: null,
		release: async () => {
			try {
				for (const budget of held) await releaseOne(db, budget, now);
			} catch (err) {
				// A leaked reservation costs one slot until the window rolls. Not
				// worth failing the request the caller already succeeded at.
				log.warn("email budget release failed", {
					error: (err as Error).message,
				});
			}
		},
	};
};
