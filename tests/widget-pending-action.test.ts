import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireAllPending, pendingFor, schedulePending } from "../src/widget/pending-action";

describe("pending-action", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		fireAllPending();
		vi.useRealTimers();
	});

	it("fires once after ms", () => {
		const fire = vi.fn();
		schedulePending("k1", fire, 5000);
		vi.advanceTimersByTime(4999);
		expect(fire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		vi.advanceTimersByTime(10000);
		expect(fire).toHaveBeenCalledTimes(1);
	});

	it("cancel prevents fire", () => {
		const fire = vi.fn();
		const p = schedulePending("k2", fire, 5000);
		p.cancel();
		vi.advanceTimersByTime(10000);
		expect(fire).not.toHaveBeenCalled();
		expect(p.settled).toBe(true);
	});

	it("fireNow fires once and settles", () => {
		const fire = vi.fn();
		const p = schedulePending("k3", fire, 5000);
		p.fireNow();
		p.fireNow();
		vi.advanceTimersByTime(10000);
		expect(fire).toHaveBeenCalledTimes(1);
		expect(p.settled).toBe(true);
	});

	it("fireAllPending fires only unsettled entries", () => {
		const a = vi.fn();
		const b = vi.fn();
		const c = vi.fn();
		schedulePending("a", a, 5000);
		schedulePending("b", b, 5000).cancel();
		schedulePending("c", c, 5000).fireNow();
		fireAllPending();
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).not.toHaveBeenCalled();
		expect(c).toHaveBeenCalledTimes(1);
	});

	it("settled entries leave pendingFor", () => {
		const p = schedulePending("k5", () => {}, 5000);
		expect(pendingFor("k5")).toBe(p);
		vi.advanceTimersByTime(5000);
		expect(pendingFor("k5")).toBeUndefined();
	});
});
