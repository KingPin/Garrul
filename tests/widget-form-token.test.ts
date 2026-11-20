/**
 * The widget skips the form-token request when config says the route would
 * 404. Only an explicit `false` skips: an older server that does not send the
 * field keeps the legacy fetch, because on that server the route may be live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formTokenWanted, pickFormToken } from "../src/widget/boot";
import { createFormTokenCache } from "../src/widget/form-token";

describe("formTokenWanted", () => {
	it("keeps the legacy fetch when the field is missing", () => {
		expect(formTokenWanted(undefined)).toBe(true);
		expect(formTokenWanted(null)).toBe(true);
		expect(formTokenWanted({})).toBe(true);
	});

	it("fetches when the server says the check is on", () => {
		expect(formTokenWanted({ form_token_enabled: true })).toBe(true);
	});

	it("skips only on an explicit false", () => {
		expect(formTokenWanted({ form_token_enabled: false })).toBe(false);
	});
});

const MIN = 60_000;
const slot = (age: number, now = 10 * 60 * MIN) => ({ token: `t${age}`, mintedAt: now - age });
const NOW = 10 * 60 * MIN;

describe("pickFormToken", () => {
	it("keeps a lone young current", () => {
		expect(pickFormToken(slot(20_000), null, NOW)).toBe("current");
	});
	it("a young next loses to current; a mature next wins", () => {
		expect(pickFormToken(slot(51 * MIN), slot(59_999), NOW)).toBe("current");
		expect(pickFormToken(slot(51 * MIN), slot(60_000), NOW)).toBe("next");
	});
	it("55 min is expired", () => {
		expect(pickFormToken(slot(55 * MIN - 1), null, NOW)).toBe("current");
		expect(pickFormToken(slot(55 * MIN), null, NOW)).toBe("none");
	});
	it("expired current with young next picks next", () => {
		expect(pickFormToken(slot(56 * MIN), slot(1000), NOW)).toBe("next");
	});
	it("nothing cached is none", () => {
		expect(pickFormToken(null, null, NOW)).toBe("none");
	});
});

describe("createFormTokenCache", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const make = (results: Array<string | null>) => {
		let n = 0;
		const mint = vi.fn(async () => results[Math.min(n++, results.length - 1)] ?? null);
		return { mint, cache: createFormTokenCache(mint, Date.now) };
	};

	it("a failed mint caches nothing and a later ensure retries", async () => {
		const { mint, cache } = make([null, "A"]);
		cache.ensure();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(30_000);
		cache.ensure();
		await vi.advanceTimersByTimeAsync(0);
		expect(mint).toHaveBeenCalledTimes(2);
		expect(await cache.token()).toBe("A");
		expect(mint).toHaveBeenCalledTimes(2);
	});

	it("a failing endpoint is left alone for 30 s, except when the network returns", async () => {
		const { mint, cache } = make([null, null, "A"]);
		cache.ensure();
		await vi.advanceTimersByTimeAsync(0);
		for (let i = 0; i < 5; i++) cache.ensure(); // five more focuses
		await vi.advanceTimersByTimeAsync(29_000);
		cache.ensure();
		await vi.advanceTimersByTimeAsync(0);
		expect(mint).toHaveBeenCalledTimes(1);
		cache.ensure(true); // `online`
		await vi.advanceTimersByTimeAsync(0);
		expect(mint).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(30_000);
		cache.ensure();
		await vi.advanceTimersByTimeAsync(0);
		expect(mint).toHaveBeenCalledTimes(3);
		expect(await cache.token()).toBe("A");
	});

	it("the refresh timer skips a hidden tab; becoming visible refreshes", async () => {
		let hidden = false;
		let n = 0;
		const mint = vi.fn(async () => `T${n++}`);
		const cache = createFormTokenCache(mint, Date.now, () => hidden);
		cache.ensure();
		await vi.advanceTimersByTimeAsync(0);
		hidden = true;
		await vi.advanceTimersByTimeAsync(120 * MIN);
		expect(mint).toHaveBeenCalledTimes(1);
		hidden = false;
		cache.ensure(); // visibilitychange
		await vi.advanceTimersByTimeAsync(0);
		expect(mint).toHaveBeenCalledTimes(2);
	});

	it("refreshes at 50, 100, 150 min with no gap", async () => {
		const start = Date.now();
		const mintedAt = new Map<string, number>();
		let n = 0;
		const mint = vi.fn(async () => {
			const t = `T${n++}`;
			mintedAt.set(t, Date.now());
			return t;
		});
		const cache = createFormTokenCache(mint, Date.now);
		cache.ensure();
		await vi.advanceTimersByTimeAsync(0);
		for (let m = 0; m < 160; m++) {
			const t = await cache.token();
			expect(t).not.toBe("");
			expect(Date.now() - (mintedAt.get(t) as number)).toBeLessThan(55 * MIN);
			await vi.advanceTimersByTimeAsync(MIN);
		}
		expect(Date.now() - start).toBe(160 * MIN);
		// Initial mint at 0, refreshes at 50, 101, 152 (each lands at 50 min of the previous).
		expect(mint).toHaveBeenCalledTimes(4);
	});

	it("a resume after 70 min of suspension refreshes on trigger and picks the new token", async () => {
		const { mint, cache } = make(["A", "B"]);
		cache.ensure();
		await vi.advanceTimersByTimeAsync(0);
		vi.setSystemTime(Date.now() + 70 * MIN); // suspended: no timers ran
		cache.ensure();
		await vi.advanceTimersByTimeAsync(0);
		expect(mint).toHaveBeenCalledTimes(2);
		expect(await cache.token()).toBe("B");
	});

	it("a suspension that expires an unpromoted refresh mints again on trigger", async () => {
		const { mint, cache } = make(["A", "B", "C"]);
		cache.ensure();
		await vi.advanceTimersByTimeAsync(50 * MIN); // the background refresh mints B
		expect(mint).toHaveBeenCalledTimes(2);
		vi.setSystemTime(Date.now() + 60 * MIN); // suspended before B was promoted
		cache.ensure();
		await vi.advanceTimersByTimeAsync(0);
		expect(mint).toHaveBeenCalledTimes(3);
		expect(await cache.token()).toBe("C");
		expect(mint).toHaveBeenCalledTimes(3);
	});

	it("submit mints once when every mint failed, and disabled returns empty", async () => {
		const { mint, cache } = make([null, "S"]);
		cache.ensure();
		await vi.advanceTimersByTimeAsync(0);
		expect(await cache.token()).toBe("S");
		expect(mint).toHaveBeenCalledTimes(2);
		cache.setEnabled(false);
		expect(await cache.token()).toBe("");
	});

	it("enabling after disabled clears both slots", async () => {
		const { mint, cache } = make(["A", "B"]);
		cache.ensure();
		await vi.advanceTimersByTimeAsync(0);
		cache.setEnabled(false);
		cache.setEnabled(true);
		expect(await cache.token()).toBe("B");
		expect(mint).toHaveBeenCalledTimes(2);
	});
});
