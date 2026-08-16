/**
 * Cloudflare Turnstile token verification.
 *
 * Server-side verifier endpoint:
 *   https://challenges.cloudflare.com/turnstile/v0/siteverify
 *
 * Returns true if the token is valid AND was issued for the expected
 * hostname. Anonymous comment POSTs MUST go through this. OAuth-
 * authenticated comments skip Turnstile unless the operator opted into
 * `turnstile_always` — see `turnstileAlwaysOn` below.
 *
 * The hostname check matters because a Turnstile sitekey is not bound
 * to a single domain — Cloudflare lets operators list multiple. Without
 * the check, a token solved on any site sharing the operator's sitekey
 * would be accepted here.
 *
 * `data.hostname` reflects the page that SOLVED the challenge. The
 * Garrul widget renders Turnstile inside a same-origin iframe served by
 * this Worker (GET /embed/turnstile-frame — the Shadow-DOM-dodging fix),
 * so `data.hostname` is always this Worker's own hostname. Callers
 * derive expectedHostname from the request URL. See routes/api.comments.ts
 * for the canonical call site.
 *
 * In dev, Cloudflare provides "always passes" test keys — see
 * .dev.vars.example for the values. The test keys return their own
 * fake hostname (`example.com`); callers in dev pass that as
 * expectedHostname so the check stays exercised.
 */
const ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Whether a *signed-in* comment also has to carry a Turnstile token.
 *
 * The default answer is no: an OAuth session already costs an attacker an
 * account, and challenging every reply from a known author is friction for
 * the people an operator least wants to annoy. Operators who would rather
 * pay that friction than field scripted posting from throwaway accounts flip
 * the `turnstile_always` flag (env `TURNSTILE_ALWAYS`, or the admin Settings
 * → Moderation toggle).
 *
 * The site key is part of the predicate, not an afterthought. The widget only
 * renders a challenge when `/api/v1/config` hands it a site key, so an
 * install that turned the flag on without configuring Turnstile would reject
 * every comment from a composer that has no way to produce a token — the flag
 * would take posting down entirely rather than tighten it. Both the config
 * route and the POST handler resolve the answer through here so the widget
 * and the server can never disagree about whether a token is expected.
 *
 * The anonymous path does NOT use this: it requires a token unconditionally,
 * which is the older and deliberately fail-closed rule.
 */
export const turnstileAlwaysOn = (
	flag: boolean,
	siteKey: string | undefined,
): boolean => flag && !!siteKey;

type SiteverifyResponse = {
	success: boolean;
	hostname?: string;
	"error-codes"?: string[];
};

export type VerifyTurnstileOptions = {
	clientIp?: string;
	expectedHostname: string;
};

export const verifyTurnstile = async (
	token: string,
	secret: string,
	opts: VerifyTurnstileOptions,
): Promise<boolean> => {
	if (!token || !secret) return false;
	const form = new URLSearchParams();
	form.set("secret", secret);
	form.set("response", token);
	if (opts.clientIp) form.set("remoteip", opts.clientIp);

	const res = await fetch(ENDPOINT, {
		method: "POST",
		body: form,
		headers: { "content-type": "application/x-www-form-urlencoded" },
	});
	if (!res.ok) return false;
	try {
		const data = (await res.json()) as SiteverifyResponse;
		if (data.success !== true) return false;
		if (!data.hostname || data.hostname !== opts.expectedHostname) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
};
