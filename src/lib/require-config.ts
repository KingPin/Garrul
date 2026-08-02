/**
 * Startup configuration assertion.
 *
 * Workers have no boot hook — `env` only exists inside a request — so the
 * closest thing to a boot-time check is a middleware that runs ahead of every
 * route. This one refuses to serve when a secret the whole Worker depends on
 * is unset, so the operator gets one named log line instead of scattered,
 * anonymous 500s.
 *
 * Only two secrets qualify. Both are generated for the operator by
 * `scripts/setup.sh`, neither has a "feature is off" mode, and both currently
 * fail in a way that is hard to read from the outside:
 *
 *   IP_HASH_SECRET  WebCrypto throws on a zero-length HMAC key, so each of the
 *                   eight endpoints that hashes a client IP returned an opaque
 *                   500 with a stack trace in the logs and nothing naming the
 *                   cause.
 *   JWT_SECRET      signs the OAuth state payload; unset means every login
 *                   round-trip fails verification at the callback, which reads
 *                   as "OAuth is broken" rather than "a secret is missing".
 *
 * Turnstile is deliberately *not* on the list even though the release manifest
 * marks it required: an instance that only accepts OAuth-authenticated
 * comments works fine without it, and `verifyTurnstile` already fails closed
 * for anonymous posts. Hard-failing here would take such a deployment offline
 * on upgrade for a configuration it never needed.
 */
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../index";
import { log } from "./log";

export const REQUIRED_SECRETS = ["IP_HASH_SECRET", "JWT_SECRET"] as const;

export const missingRequiredSecrets = (env: Partial<Bindings>): string[] =>
	REQUIRED_SECRETS.filter((name) => {
		const value = env[name];
		return typeof value !== "string" || value.length === 0;
	});

export const requireConfig =
	(): MiddlewareHandler<{ Bindings: Bindings }> => async (c, next) => {
		const missing = missingRequiredSecrets(c.env);
		if (missing.length > 0) {
			// Named in the log, not in the response body. The operator reads
			// `wrangler tail`; a prober learns only that the instance is broken,
			// which is the same posture as the ENV=dev guard in src/index.ts.
			log.error("config.missing_required_secrets", { missing });
			return c.json({ error: "server_misconfigured" }, 500);
		}
		return next();
	};
