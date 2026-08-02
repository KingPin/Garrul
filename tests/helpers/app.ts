/**
 * Shared types for the route-test harnesses.
 *
 * Every route test builds a throwaway `new Hono<{ Bindings: Record<string,
 * unknown> }>()`, mounts the router under test, and drives it through a local
 * `get`/`post` helper. Those helpers were typed `app: Hono`, which defaults to
 * `Hono<BlankEnv>` — a different type, so the call sites only compiled because
 * tests were never typechecked (tsconfig.json pointed at `test/**` while the
 * directory is `tests/`).
 *
 * `TestApp` is that one shape, named once.
 */
import type { Hono } from "hono";

/** The env a test harness hands to `app.request()` — a loose bag of bindings. */
export type TestEnv = Record<string, unknown>;

/** A Hono app built by a route test. Matches `new Hono<{ Bindings: TestEnv }>()`. */
export type TestApp = Hono<{ Bindings: TestEnv }>;

/**
 * Just the `request()` surface a test harness drives.
 *
 * Use this when the harness builds its app with the real `Bindings` type and
 * mounts routers with `.route()`: that returns a Hono whose *schema* generic
 * has been merged, so it no longer matches a plain `Hono<{ Bindings: … }>`
 * annotation. Depending only on `request` sidesteps the generics entirely.
 */
export type Requestable = {
	request(
		input: RequestInfo | URL,
		requestInit?: RequestInit,
		env?: unknown,
		executionCtx?: unknown,
	): Response | Promise<Response>;
};
