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
			const body = await res.text().catch(() => "");
			log.warn("email.send_failed", {
				status: res.status,
				body: body.slice(0, 200),
			});
			return false;
		}
		return true;
	} catch (err) {
		log.warn("email.send_error", { error: String(err) });
		return false;
	}
};
