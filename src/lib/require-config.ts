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
 *
 * The same two secrets are also refused outside `ENV=dev` when they still hold
 * the `.dev.vars.example` placeholder. Those two strings are public — they are
 * in this repository — so a production Worker running on them has an OAuth
 * state signer and an IP-hash pepper that anyone can look up: forgeable login
 * state, and every `ip_hash` reversible by brute force over the IPv4 space.
 * They are also the one weak value a real install predictably ends up with:
 * `setup.sh` generates 32 random bytes for anything else, and an operator who
 * copies `.dev.vars` into `wrangler secret put` never sees an error. Nothing
 * else about the value is judged here (no length floor, no entropy guess);
 * the check is exact-match against the two known placeholders.
 */
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../index";
import { log } from "./log";

export const REQUIRED_SECRETS = ["IP_HASH_SECRET", "JWT_SECRET"] as const;

/**
 * The `.dev.vars.example` values, verbatim. The source of truth is
 * `devPlaceholder` in scripts/config-registry.ts, but nothing under src/ may
 * import scripts/ (it would drag the registry into the Worker bundle), so the
 * two strings are repeated here and tests/require-config.test.ts pins them to
 * the registry. Change one, and that test names the other.
 */
export const DEV_PLACEHOLDERS: Record<(typeof REQUIRED_SECRETS)[number], string> = {
	IP_HASH_SECRET: "dev-ip-hash-pepper-change-me",
	JWT_SECRET: "dev-jwt-secret-change-me",
};

export const missingRequiredSecrets = (env: Partial<Bindings>): string[] =>
	REQUIRED_SECRETS.filter((name) => {
		const value = env[name];
		return typeof value !== "string" || value.length === 0;
	});

/**
 * Required secrets still set to their public dev placeholder, on an instance
 * that is not `ENV=dev`. Empty in dev: the placeholders exist so `wrangler dev`
 * works out of the box, and refusing them there would break the one place they
 * belong.
 */
export const placeholderRequiredSecrets = (env: Partial<Bindings>): string[] => {
	if (env.ENV === "dev") return [];
	return REQUIRED_SECRETS.filter((name) => env[name] === DEV_PLACEHOLDERS[name]);
};

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
		const placeholder = placeholderRequiredSecrets(c.env);
		if (placeholder.length > 0) {
			log.error("config.placeholder_required_secrets", { placeholder });
			return c.json({ error: "server_misconfigured" }, 500);
		}
		return next();
	};
