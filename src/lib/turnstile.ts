/**
 * Cloudflare Turnstile token verification.
 *
 * Server-side verifier endpoint:
 *   https://challenges.cloudflare.com/turnstile/v0/siteverify
 *
 * Returns true if the token is valid AND was issued for the expected
 * hostname. Anonymous comment POSTs MUST go through this. OAuth-
 * authenticated comments skip Turnstile.
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
