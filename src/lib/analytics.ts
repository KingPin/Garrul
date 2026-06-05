/**
 * Workers Analytics Engine writer.
 *
 * AE rows are wide blob+double tuples. We pack our domain into:
 *   blobs:    [event_name, post_slug, provider, outcome]
 *   doubles:  [count]
 *   index:    event_name (for cheap GROUP BY event)
 *
 * Writes are fire-and-forget. If the binding is missing or the write
 * fails, we don't surface it — observability shouldn't break the request
 * path. Reads happen in the CF dashboard / SQL API; we don't query AE
 * from the Worker.
 *
 * Why AE over console.log: cheap aggregation in the dashboard, no log
 * volume billing, and works fine alongside structured logs.
 */

export type EventName =
	| "comment.posted"
	| "comment.deleted"
	| "comment.edited"
	| "ratelimit.hit"
	| "oauth.start"
	| "oauth.complete"
	| "oauth.failed"
	| "reaction.toggled"
	| "vote.cast"
	| "page_reaction.toggled"
	| "page_vote.cast";

type WriteFields = {
	post_slug?: string | null;
	provider?: string | null;
	outcome?: string | null;
};

/**
 * Note the type guard: AnalyticsEngineDataset is bound by wrangler.toml
 * but operators running without [[analytics_engine_datasets]] won't have
 * it. `writeDataPoint` is fire-and-forget and we suppress its throw, so
 * callers don't need to await it.
 */
export const writeEvent = (
	ae: AnalyticsEngineDataset | undefined,
	event: EventName,
	fields: WriteFields = {},
): void => {
	if (!ae) return;
	try {
		ae.writeDataPoint({
			indexes: [event],
			blobs: [
				event,
				fields.post_slug ?? "",
				fields.provider ?? "",
				fields.outcome ?? "",
			],
			doubles: [1],
		});
	} catch {
		// AE writes are best-effort. A missing binding or transient write
		// failure must not break the request the caller is serving.
	}
};
