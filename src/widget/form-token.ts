import {
	FORM_TOKEN_MATURE_MS,
	FORM_TOKEN_MAX_MS,
	type FormTokenSlot,
	pickFormToken,
} from "./boot";

/** Start a background refresh once the current token is this old. */
const REFRESH_MS = 50 * 60_000;
/** After a failed mint, triggers (focus) leave the endpoint alone this long. */
const RETRY_AFTER_FAIL_MS = 30_000;

/**
 * Two-slot form-token cache. DOM-free: `mint`, `now` and `hidden` are injected.
 * A failed mint (null) caches nothing and is retried only by `ensure()` (the
 * caller wires it to composer focus, `online`, visible), and not within
 * RETRY_AFTER_FAIL_MS unless `ensure(true)` says the network just returned.
 * `token()` is the one path that mints at submit time, and only when no cached
 * token is usable. The timer never refreshes a hidden tab: becoming visible
 * calls `ensure()`.
 */
export const createFormTokenCache = (
	mint: () => Promise<string | null>,
	now: () => number,
	hidden: () => boolean = () => false,
) => {
	let enabled = true;
	let current: FormTokenSlot = null;
	let next: FormTokenSlot = null;
	let pending: Promise<void> | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let epoch = 0;
	let failedAt: number | null = null;

	const schedule = (): void => {
		clearTimeout(timer);
		const t = now();
		const at = next
			? next.mintedAt + FORM_TOKEN_MATURE_MS
			: current
				? current.mintedAt + REFRESH_MS
				: Number.NEGATIVE_INFINITY;
		// Already due and nothing to promote: a failed refresh waits for a trigger.
		if (at <= t) return;
		timer = setTimeout(() => {
			if (!hidden()) sync();
		}, at - t);
	};

	const fetchInto = (into: "current" | "next"): Promise<void> => {
		if (pending) return pending;
		const e = epoch;
		const p: Promise<void> = mint()
			.catch(() => null)
			.then((token) => {
				if (e !== epoch) return;
				pending = null;
				failedAt = token ? null : now();
				if (!token) return;
				const slot = { token, mintedAt: now() };
				if (into === "current") current = slot;
				else next = slot;
				sync();
			});
		pending = p;
		return p;
	};

	const sync = (force = false): void => {
		if (!enabled) return;
		if (pickFormToken(current, next, now()) === "next") {
			current = next;
			next = null;
		}
		// An expired slot is dead weight: a kept `next` blocks every refresh below
		// and leaves the submit to mint a token too young to pass the timing check.
		const t = now();
		if (next && t - next.mintedAt >= FORM_TOKEN_MAX_MS) next = null;
		if (current && t - current.mintedAt >= FORM_TOKEN_MAX_MS) current = null;
		const backedOff = !force && failedAt != null && now() - failedAt < RETRY_AFTER_FAIL_MS;
		if (!backedOff) {
			if (!current && !next) void fetchInto("current");
			else if (current && !next && now() - current.mintedAt >= REFRESH_MS) void fetchInto("next");
		}
		schedule();
	};

	return {
		/** Mint if there is no token, refresh if the current one is old. No-op when healthy. */
		ensure: (force = false): void => sync(force),
		/** A flip from disabled to enabled drops both slots (and any in-flight mint). */
		setEnabled(wanted: boolean): void {
			if (wanted && !enabled) {
				current = next = null;
				pending = null;
				failedAt = null;
				epoch++;
			}
			enabled = wanted;
			if (!wanted) clearTimeout(timer);
		},
		/** The token a submit should send; "" when disabled or every mint failed. */
		async token(): Promise<string> {
			if (!enabled) return "";
			sync();
			let which = pickFormToken(current, next, now());
			if (which === "none") {
				await (pending ?? fetchInto("current"));
				which = pickFormToken(current, next, now());
			}
			return (which === "next" ? next : which === "current" ? current : null)?.token ?? "";
		},
	};
};
