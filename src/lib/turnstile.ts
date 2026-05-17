/**
 * Cloudflare Turnstile token verification.
 *
 * Server-side verifier endpoint:
 *   https://challenges.cloudflare.com/turnstile/v0/siteverify
 *
 * Returns true if the token is valid; false otherwise. Anonymous
 * comment POSTs MUST go through this. OAuth-authenticated comments
 * skip Turnstile.
 *
 * In dev, Cloudflare provides "always passes" test keys — see
 * .dev.vars.example for the values.
 */
const ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const verifyTurnstile = async (
	token: string,
	secret: string,
	clientIp?: string,
): Promise<boolean> => {
	if (!token || !secret) return false;
	const form = new URLSearchParams();
	form.set("secret", secret);
	form.set("response", token);
	if (clientIp) form.set("remoteip", clientIp);

	const res = await fetch(ENDPOINT, {
		method: "POST",
		body: form,
		headers: { "content-type": "application/x-www-form-urlencoded" },
	});
	if (!res.ok) return false;
	try {
		const data = (await res.json()) as { success: boolean };
		return data.success === true;
	} catch {
		return false;
	}
};
