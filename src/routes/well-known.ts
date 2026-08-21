/**
 * GET /.well-known/security.txt — RFC 9116 vulnerability-disclosure pointer.
 *
 * Served only when the operator has configured a disclosure contact (the
 * `security_contact` setting; env-var default SECURITY_CONTACT). Contact is
 * the one field the RFC makes mandatory, so with nothing configured the
 * honest answer is 404, not a file pointing nowhere.
 *
 * The contact accepts an email address (emitted as mailto:) or an https:// /
 * mailto: URI verbatim; anything else is treated as unconfigured — RFC 9116
 * §2.5.3 requires web URIs to be https, and serving a malformed URI is worse
 * than serving none. Expires is computed per request (~6 months out; the RFC
 * caps usefulness at a year) so the file can never quietly go stale.
 *
 * No Origin gating — public file, same exemption pattern as GET /AGENTS.md.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { loadTexts } from "../lib/settings";
import { resolveInstance } from "./agents";

export const wellKnown = new Hono<{ Bindings: Bindings }>();

const EXPIRES_MS = 180 * 24 * 60 * 60 * 1000;

// Deliberately loose — the operator typed the address into their own settings
// page; this only has to catch "is an address at all", not deliverability.
// Also applied to the part after mailto:, where it tolerates a ?subject=
// query in the domain tail — no whitespace, no second @, so it stays a URI.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Normalize the operator-entered contact to an RFC 9116 Contact URI. */
export const contactUri = (raw: string): string | null => {
	const v = raw.trim();
	// A URI has no whitespace; the value comes from a settings *textarea*, so an
	// embedded newline would otherwise land in the emitted file as a forged line.
	if (/\s/.test(v)) return null;
	if (/^https:\/\//i.test(v)) {
		// The prefix alone isn't enough — a degenerate "https://" would publish
		// a Contact line pointing nowhere. Require a parseable URL with a host.
		try {
			return new URL(v).hostname ? v : null;
		} catch {
			return null;
		}
	}
	if (/^mailto:/i.test(v)) {
		return EMAIL_RE.test(v.slice("mailto:".length)) ? v : null;
	}
	// Bare email address → mailto:.
	if (EMAIL_RE.test(v)) return `mailto:${v}`;
	return null;
};

wellKnown.get("/.well-known/security.txt", async (c) => {
	const texts = await loadTexts(c.env);
	const contact = contactUri(texts.security_contact);
	if (!contact) return c.notFound();

	const hostHeader = c.req.header("host") ?? new URL(c.req.url).host;
	const { url } = resolveInstance(hostHeader, c.env.CANONICAL_URL);
	const body = [
		`Contact: ${contact}`,
		`Expires: ${new Date(Date.now() + EXPIRES_MS).toISOString()}`,
		`Canonical: ${url}/.well-known/security.txt`,
		"Preferred-Languages: en",
	].join("\n");

	c.header("content-type", "text/plain; charset=utf-8");
	c.header("cache-control", "public, max-age=300");
	c.header("x-content-type-options", "nosniff");
	return c.body(`${body}\n`);
});
