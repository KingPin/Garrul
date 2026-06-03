/**
 * Cron-pass isolation (issue #16). The scheduled handler runs two
 * independent passes per tick — digest + webhook retries — each under
 * its own waitUntil with its own catch. These tests pin that a throw
 * in either pass (a) never skips the other and (b) is caught and
 * logged rather than surfacing as an unhandled rejection.
 *
 * The two run* functions are mocked at the module boundary; everything
 * else in src/index.ts loads for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/digest", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/digest")>()),
	runDigest: vi.fn(),
}));
vi.mock("../src/lib/webhook", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/webhook")>()),
	runWebhookRetries: vi.fn(),
}));

import worker from "../src/index";
import { runDigest } from "../src/lib/digest";
import { runWebhookRetries } from "../src/lib/webhook";
import { log } from "../src/lib/log";

// Collects waitUntil promises so the test can settle them and prove
// none reject.
const makeCtx = () => {
	const tracked: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (p: Promise<unknown>) => {
			tracked.push(p);
		},
		passThroughOnException: () => {},
	} as unknown as ExecutionContext;
	return { ctx, tracked };
};

const scheduled = (ctx: ExecutionContext) =>
	worker.scheduled(
		{} as ScheduledEvent,
		{} as Parameters<typeof worker.scheduled>[1],
		ctx,
	);

describe("scheduled handler pass isolation", () => {
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.mocked(runDigest).mockReset().mockResolvedValue(undefined);
		vi.mocked(runWebhookRetries).mockReset().mockResolvedValue(undefined);
		errSpy = vi.spyOn(log, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		errSpy.mockRestore();
	});

	it("runs both passes under separate waitUntil calls", async () => {
		const { ctx, tracked } = makeCtx();
		await scheduled(ctx);
		expect(tracked).toHaveLength(2);
		await Promise.all(tracked);
		expect(runDigest).toHaveBeenCalledTimes(1);
		expect(runWebhookRetries).toHaveBeenCalledTimes(1);
		expect(errSpy).not.toHaveBeenCalled();
	});

	it("a digest failure doesn't skip webhook retries and is caught + logged", async () => {
		vi.mocked(runDigest).mockRejectedValue(new Error("digest boom"));
		const { ctx, tracked } = makeCtx();
		await scheduled(ctx);
		// Both promises settle without rejection — the catch is inside.
		await expect(Promise.all(tracked)).resolves.toBeDefined();
		expect(runWebhookRetries).toHaveBeenCalledTimes(1);
		expect(errSpy).toHaveBeenCalledWith(
			"scheduled.digest",
			expect.objectContaining({ error: expect.stringContaining("digest boom") }),
		);
	});

	it("a webhook-retries failure doesn't skip the digest and is caught + logged", async () => {
		vi.mocked(runWebhookRetries).mockRejectedValue(new Error("retry boom"));
		const { ctx, tracked } = makeCtx();
		await scheduled(ctx);
		await expect(Promise.all(tracked)).resolves.toBeDefined();
		expect(runDigest).toHaveBeenCalledTimes(1);
		expect(errSpy).toHaveBeenCalledWith(
			"scheduled.webhook_retries",
			expect.objectContaining({ error: expect.stringContaining("retry boom") }),
		);
	});
});
