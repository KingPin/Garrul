import { Hono } from "hono";
import { health } from "./routes/health";
import { comments } from "./routes/api.comments";
import { requestLogger } from "./lib/log";
import { corsAndCsrf } from "./lib/cors";
import { sessionMiddleware } from "./lib/session";

export type Bindings = {
	DB: D1Database;
	RATE_LIMITS: KVNamespace;
	OAUTH_STATE: KVNamespace;
	SESSIONS: KVNamespace;
	TREE_CACHE: KVNamespace;
	ANALYTICS: AnalyticsEngineDataset;
	ENV: string;
	ALLOWED_ORIGINS: string;
	ADMIN_EMAILS: string;
	EDIT_WINDOW_MINUTES: string;
	EMAIL_PROVIDER: string;
	JWT_SECRET: string;
	IP_HASH_SECRET: string;
	TURNSTILE_SITE_KEY: string;
	TURNSTILE_SECRET: string;
	GH_CLIENT_ID: string;
	GH_CLIENT_SECRET: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	RESEND_API_KEY: string;
	WEBHOOK_URL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", requestLogger());
app.use("/api/*", corsAndCsrf());
app.use("/api/*", sessionMiddleware());

app.route("/api/v1/health", health);
app.route("/api/v1/comments", comments);

app.get("/", (c) =>
	c.text(
		"Garrul — self-hosted comments on Cloudflare. See https://github.com/KingPin/Garrul",
	),
);

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
	console.error(
		JSON.stringify({
			level: "error",
			ts: new Date().toISOString(),
			msg: "unhandled.error",
			error: err.message,
			stack: err.stack,
		}),
	);
	return c.json({ error: "internal_error" }, 500);
});

export default app;
