import type { MiddlewareHandler } from "hono";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogContext = {
	requestId: string;
	method: string;
	path: string;
};

type LogFields = Record<string, unknown>;

const emit = (
	level: LogLevel,
	ctx: LogContext | null,
	msg: string,
	fields?: LogFields,
): void => {
	const line: Record<string, unknown> = {
		level,
		ts: new Date().toISOString(),
		msg,
	};
	if (ctx) {
		line.request_id = ctx.requestId;
		line.method = ctx.method;
		line.path = ctx.path;
	}
	if (fields) Object.assign(line, fields);
	const writer = level === "error" ? console.error : console.log;
	writer(JSON.stringify(line));
};

export const log = {
	debug: (msg: string, fields?: LogFields) => emit("debug", null, msg, fields),
	info: (msg: string, fields?: LogFields) => emit("info", null, msg, fields),
	warn: (msg: string, fields?: LogFields) => emit("warn", null, msg, fields),
	error: (msg: string, fields?: LogFields) => emit("error", null, msg, fields),
};

const newRequestId = (): string => {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

const REQUEST_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// A path segment long enough to be a secret. Capability tokens ride in the URL
// path — the subscribe confirm and unsubscribe links are 32 random bytes
// hex-encoded (src/routes/api.subscriptions.ts) — and every request logs its
// pathname twice. Anyone with log-read access could otherwise lift a live
// confirm token and turn double-opt-in into single-opt-in, or unsubscribe a
// reader at will. A ULID is 26 characters, so comment and user IDs stay
// readable and the logs remain useful for debugging.
const TOKENISH_SEGMENT = /^[A-Za-z0-9_-]{32,}$/;

// C0 controls plus DEL, built from escapes so the source stays printable.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

// Long enough for any real Garrul route, short enough that a caller can't pad
// the log stream with a multi-kilobyte path.
const MAX_LOGGED_PATH = 200;

/**
 * Prepare a request pathname for logging: redact secret-looking segments, drop
 * control characters, cap the length.
 *
 * The control-char strip is defense in depth rather than the primary fix —
 * `URL` leaves `%0a`/`%0d` percent-encoded in `pathname` and `JSON.stringify`
 * escapes any real control character, so neither reaches a log line raw today.
 * It costs one pass and holds even if the emitter stops going through JSON.
 */
export const sanitizeLoggedPath = (pathname: string): string => {
	const redacted = pathname
		.split("/")
		.map((seg) => (TOKENISH_SEGMENT.test(seg) ? "***" : seg))
		.join("/")
		.replace(CONTROL_CHARS, "");
	return redacted.length > MAX_LOGGED_PATH
		? `${redacted.slice(0, MAX_LOGGED_PATH)}...`
		: redacted;
};

export const requestLogger = (): MiddlewareHandler => {
	return async (c, next) => {
		// Incoming x-request-id is reflected back in our response header and
		// echoed into every log line. Reject anything that isn't a short opaque
		// token so a caller can't inject newlines / log-forgery payloads or
		// HTTP-header smuggling characters via the response.
		const incoming = c.req.header("x-request-id");
		const requestId =
			incoming && REQUEST_ID_RE.test(incoming) ? incoming : newRequestId();
		const ctx: LogContext = {
			requestId,
			method: c.req.method,
			path: sanitizeLoggedPath(new URL(c.req.url).pathname),
		};
		c.set("requestId" as never, requestId);
		c.header("x-request-id", requestId);
		const start = Date.now();
		emit("info", ctx, "request.start");
		try {
			await next();
		} finally {
			emit("info", ctx, "request.end", {
				status: c.res.status,
				duration_ms: Date.now() - start,
			});
		}
	};
};
