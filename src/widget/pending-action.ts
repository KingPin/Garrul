/**
 * Registry of delayed actions that must survive a re-render. A UI that
 * rebuilds its DOM cannot hold the timer in a closure over the old node, so
 * the timer lives here, keyed by what it acts on, and a rebuilt view asks
 * `pendingFor(key)` whether to draw its "pending" state.
 *
 * Generic on purpose: the caller owns what `fire` does and where its result
 * lands (look the live row up at settle time, never close over a node).
 */

export type Pending = {
	/** Stop the timer; `fire` never runs. No-op once settled. */
	cancel(): void;
	/** Run `fire` now, once. No-op once settled. */
	fireNow(): void;
	readonly settled: boolean;
};

const registry = new Map<string, Pending>();

export const schedulePending = (key: string, fire: () => void, ms: number): Pending => {
	// A second schedule for the same key must not drop the first action.
	registry.get(key)?.fireNow();
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const settle = (): void => {
		settled = true;
		clearTimeout(timer);
		if (registry.get(key) === p) registry.delete(key);
	};
	const p: Pending = {
		cancel() {
			if (!settled) settle();
		},
		fireNow() {
			if (settled) return;
			settle();
			fire();
		},
		get settled() {
			return settled;
		},
	};
	timer = setTimeout(p.fireNow, ms);
	registry.set(key, p);
	return p;
};

export const pendingFor = (key: string): Pending | undefined => registry.get(key);

/** Fire every unsettled entry (pagehide: a deliberate action must not be lost). */
export const fireAllPending = (): void => {
	for (const p of [...registry.values()]) p.fireNow();
};
