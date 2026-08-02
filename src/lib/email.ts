/**
 * Minimal Resend client. Single endpoint we use: POST /emails.
 *
 * We deliberately don't bring in resend's SDK — the API is one fetch call
 * and we keep the bundle lean.
 *
 * EMAIL_PROVIDER must be set to "resend" to enable. Without it (or
 * without RESEND_API_KEY) the helper returns false and the caller logs
 * + continues. This way self-hosters who don't want notifications can
 * leave the env vars unset.
 */

import { log } from "./log";

export type SendEmailInput = {
	to: string;
	from: string;
	subject: string;
	html: string;
	text?: string;
};

type EmailEnv = {
	EMAIL_PROVIDER?: string;
	RESEND_API_KEY?: string;
};

// A Resend error name is a fixed enum (`validation_error`, `rate_limit_exceeded`,
// …). Clamping to that shape keeps an unexpected body from putting arbitrary
// remote text into a log line.
const RESEND_ERROR_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The error *code* from a Resend failure, and nothing else.
 *
 * Resend's error bodies look like
 *
 *     { "statusCode": 422, "name": "validation_error",
 *       "message": "Invalid `to` field. …someone@example.com…" }
 *
 * The free-text `message` interpolates the offending field, so on the digest
 * and confirmation paths it echoes a subscriber's address straight into the
 * log — and "no PII in logs" is a project rule, not a preference (CLAUDE.md,
 * Logging). The `name` is an enum with no caller data in it, which is all an
 * operator needs to tell a bad address from a throttle from a bad key.
 */
const resendErrorCode = async (res: Response): Promise<string> => {
	try {
		const body = (await res.json()) as { name?: unknown };
		return typeof body.name === "string" && RESEND_ERROR_NAME_RE.test(body.name)
			? body.name
			: "unknown";
	} catch {
		return "unparsed";
	}
};

export const sendEmail = async (
	env: EmailEnv,
	input: SendEmailInput,
): Promise<boolean> => {
	if (env.EMAIL_PROVIDER !== "resend" || !env.RESEND_API_KEY) {
		return false;
	}
	try {
		const res = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				authorization: `Bearer ${env.RESEND_API_KEY}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				from: input.from,
				to: [input.to],
				subject: input.subject,
				html: input.html,
				...(input.text ? { text: input.text } : {}),
			}),
		});
		if (!res.ok) {
			log.warn("email.send_failed", {
				status: res.status,
				code: await resendErrorCode(res),
			});
			return false;
		}
		return true;
	} catch (err) {
		log.warn("email.send_error", { error: String(err) });
		return false;
	}
};
