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
			path: new URL(c.req.url).pathname,
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
