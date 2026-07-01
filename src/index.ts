import { Hono } from "hono";
import { health } from "./routes/health";
import { comments } from "./routes/api.comments";
import { reports } from "./routes/api.reports";
import { config } from "./routes/api.config";
import { preview } from "./routes/api.preview";
import { pageEngagement } from "./routes/api.page-engagement";
import { reactions } from "./routes/api.reactions";
import { votes } from "./routes/api.votes";
import { auth } from "./routes/auth";
import { embed } from "./routes/embed";
import { agents } from "./routes/agents";
import { iframe } from "./routes/embed-iframe";
import { admin } from "./routes/admin";
import { telegram } from "./routes/telegram";
import { feed } from "./routes/feed";
import { counts } from "./routes/api.counts";
import { permalink } from "./routes/permalink";
import { subscriptions } from "./routes/api.subscriptions";
import { runDigest } from "./lib/digest";
import { runTelegramDigest } from "./lib/telegram-digest";
import { runWebhookRetries } from "./lib/webhook";
import { log, requestLogger } from "./lib/log";
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
	FACEBOOK_CLIENT_ID: string;
	FACEBOOK_CLIENT_SECRET: string;
	TWITTER_CLIENT_ID: string;
	TWITTER_CLIENT_SECRET: string;
	DISCORD_CLIENT_ID: string;
	DISCORD_CLIENT_SECRET: string;
	OAUTH_CALLBACK_BASE: string;
	RESEND_API_KEY: string;
	EMAIL_FROM: string;
	PUBLIC_BASE_URL: string;
	CANONICAL_URL?: string;
	WEBHOOK_URL: string;
	// Telegram integration (optional; feature is off when unset).
	//   TELEGRAM_BOT_TOKEN      — BotFather token; used to send messages and
	//                             (Phase 2) receive updates. A webhook endpoint
	//                             with adapter=telegram stores the chat id in
	//                             its url column and sends via this token.
	//   TELEGRAM_WEBHOOK_SECRET — shared secret echoed by Telegram in the
	//                             X-Telegram-Bot-Api-Secret-Token header on
	//                             inbound updates; the /telegram route rejects
	//                             any request whose header doesn't match.
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_WEBHOOK_SECRET?: string;
	//   TELEGRAM_BOT_USERNAME   — the bot's @username (without @). Optional;
	//                             when set, the admin Telegram page renders a
	//                             one-tap t.me/<bot>?start=<code> deep link
	//                             instead of manual /start instructions.
	TELEGRAM_BOT_USERNAME?: string;
	// Anti-spam (all optional; each feature opts in when its env var is set).
	SPAM_PROVIDER?: string;
	AKISMET_API_KEY?: string;
	AKISMET_SITE_URL?: string;
	AI?: Ai;
	SPAM_LINK_THRESHOLD?: string;
	SPAM_HONEYPOT_MIN_MS?: string;
	SPAM_FIRST_COMMENT_MODERATE?: string;
	SPAM_FORM_TS_SECRET?: string;
	// Set to "1" or "true" to suppress the "Powered by Garrul" attribution
	// rendered under the comment list. Unset = attribution shown.
	BRANDING_HIDDEN?: string;
	// Cloudflare usage dashboard (optional). When both are set, /admin/usage
	// surfaces today's Workers / D1 / KV usage vs the free-tier ceilings via
	// Cloudflare's GraphQL Analytics API. Unset → the page shows a setup
	// guide instead of charts and the nav link is hidden.
	//
	// Token scopes required (least-privilege):
	//   - Account.Analytics: Read
	//   - Account.D1: Read
	//   - Account.Workers KV Storage: Read
	CF_API_TOKEN?: string;
	CF_ACCOUNT_ID?: string;
	// Authenticated voting. Both default to enabled. Set to "0" or "false"
	// to disable. Disabling downvotes is a brigading-mitigation switch the
	// operator can flip without redeploy.
	VOTING_ENABLED?: string;
	DOWNVOTES_ENABLED?: string;
	// Per-feature toggles. These are the env-var *defaults*; a row in the
	// `settings` table overrides the matching one at runtime (see
	// src/lib/settings.ts). Comment-level features default ON to preserve
	// existing behavior; the new page-level features default OFF so an
	// upgrade doesn't surface new UI on instances that didn't ask for it.
	COMMENTS_ENABLED?: string;
	REACTIONS_ENABLED?: string;
	PAGE_REACTIONS_ENABLED?: string;
	PAGE_VOTES_ENABLED?: string;
	// Keep deleted comments in the public tree as a placeholder instead of
	// pruning leaf deletions. Default OFF (see src/lib/settings.ts).
	SHOW_DELETED_PLACEHOLDERS?: string;
	// Numeric display settings. Env-var *defaults*; a row in the `settings`
	// table overrides the matching one at runtime (see src/lib/settings.ts).
	//   COMMENTS_PER_PAGE   — top-level threads per initial load + Load-more.
	//   REPLIES_PER_THREAD  — replies shown per parent before "Show N more"; 0 = all.
	//   AUTO_COLLAPSE_DEPTH — replies at depth >= this start collapsed; 0 = never.
	COMMENTS_PER_PAGE?: string;
	REPLIES_PER_THREAD?: string;
	AUTO_COLLAPSE_DEPTH?: string;
	// Thread auto-close. Env-var *defaults*; a `settings` row overrides at
	// runtime (see src/lib/settings.ts). Evaluated lazily at read/write time
	// (no cron). 0 = disabled.
	//   AUTO_CLOSE_DAYS — close a thread this many days after its publish date
	//                     (posts.published_at, else created_at).
	//   AUTO_CLOSE_AT   — close ALL threads at/after this epoch-ms sunset date.
	AUTO_CLOSE_DAYS?: string;
	AUTO_CLOSE_AT?: string;
	// Community auto-collapse (cosmetic, client-side). 0 = disabled.
	//   COMMUNITY_MIN_VOTES      — min total votes before the ratio applies
	//                              (brigading floor).
	//   COMMUNITY_COLLAPSE_RATIO — percent downvotes that folds a comment
	//                              (expandable). Gated on DOWNVOTES_ENABLED.
	COMMUNITY_MIN_VOTES?: string;
	COMMUNITY_COLLAPSE_RATIO?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", requestLogger());

// Fail-closed guard against a misconfigured deployment serving with
// ENV=dev: that value relaxes cookie attributes (drops Secure, switches
// from SameSite=None to Lax) and bypasses the Origin allowlist on
// state-changing routes. Wrangler's `dev` workflow is the only intended
// caller; if ENV=dev ever leaks into a non-local host, refuse to serve
// so the operator sees the misconfiguration instead of silently weakened
// security. Response body is intentionally empty — telling a probing
// attacker "this server is in dev mode" is itself a leak.
const isLocalDevHost = (host: string): boolean => {
	if (
		host === "localhost" ||
		host === "::1" ||
		host === "[::1]" ||
		host === "host.docker.internal"
	) {
		return true;
	}
	// Whole 127/8 loopback range, not just .0.0.1 — operators bind to
	// 127.0.0.2 etc. for isolated dev instances.
	if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
	// RFC 6761 reserved local TLDs.
	if (host.endsWith(".localhost") || host.endsWith(".local")) return true;
	if (host.endsWith(".test")) return true;
	return false;
};
app.use("*", async (c, next) => {
	if (c.env.ENV === "dev") {
		const host = new URL(c.req.url).hostname;
		if (!isLocalDevHost(host)) {
			log.error("ENV=dev on non-local host; refusing to serve", { host });
			return c.body(null, 500);
		}
	}
	await next();
});

// Global security headers. Cheap to set and shrinks the attack surface
// independent of which route serves the response. Admin's stricter CSP
// in src/routes/admin.ts is set after this and is not affected.
//   - HSTS: a year-long preload-eligible policy. Harmless on
//     localhost (browsers ignore on non-HTTPS hosts).
//   - Referrer-Policy / Permissions-Policy: minimize cross-site leakage
//     and disable invasive opt-out features.
//   - X-Content-Type-Options: belt-and-braces against MIME sniffing on
//     served JSON/JS.
//   - X-Frame-Options: DENY everywhere except /embed/*, which is the
//     iframe surface host sites legitimately frame. /embed.js (the
//     script bundle) lives at the root, not under /embed/, so it
//     correctly gets DENY (scripts aren't framable anyway).
app.use("*", async (c, next) => {
	await next();
	c.header("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
	c.header("referrer-policy", "no-referrer");
	c.header(
		"permissions-policy",
		"interest-cohort=(), browsing-topics=()",
	);
	c.header("x-content-type-options", "nosniff");
	if (!c.req.path.startsWith("/embed/")) {
		c.header("x-frame-options", "DENY");
	}
});

app.use("/api/*", corsAndCsrf());
app.use("/api/*", sessionMiddleware());

app.route("/api/v1/health", health);
app.route("/api/v1/comments", comments);
app.route("/api/v1/comments", reports);
app.route("/api/v1/reactions", reactions);
app.route("/api/v1/page-engagement", pageEngagement);
app.route("/api/v1/votes", votes);
app.route("/api/v1/config", config);
app.route("/api/v1/preview", preview);
app.route("/api/v1/counts", counts);
app.route("/api/v1/subscribe", subscriptions);
app.route("/api/v1/auth", auth);
app.route("/feed", feed);
app.route("/c", permalink);
app.route("/", embed);
app.route("/", agents);
app.route("/embed", iframe);
app.route("/admin", admin);
// Top-level (outside /api/*) so it bypasses corsAndCsrf + sessionMiddleware;
// the route authenticates via the Telegram secret-token header instead.
app.route("/telegram", telegram);

app.get("/", (c) =>
	c.text(
		"Garrul — self-hosted comments on Cloudflare. See https://github.com/KingPin/Garrul",
	),
);

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
	log.error("unhandled.error", {
		error: err.message,
		stack: err.stack,
	});
	return c.json({ error: "internal_error" }, 500);
});

// Cron entry — wired in wrangler.toml under [triggers].crons.
// We export the worker as a fetch+scheduled object so Cloudflare's
// scheduler can call us. The fetch handler is the Hono app; the
// scheduled handler kicks off a single digest pass.
export default {
	fetch: app.fetch,
	scheduled: async (
		_event: ScheduledEvent,
		env: Bindings,
		ctx: ExecutionContext,
	): Promise<void> => {
		// Independent passes per cron tick. Each gets its OWN waitUntil so a
		// slow pass can't starve the others, and its OWN catch so a throw in
		// one never skips the rest or surfaces as an unhandled rejection
		// (issue #16). The Telegram digest self-gates to once/day internally;
		// running it every tick just lets it decide when it's due.
		ctx.waitUntil(
			runDigest(env).catch((err) => {
				log.error("scheduled.digest", { error: String(err) });
			}),
		);
		ctx.waitUntil(
			runWebhookRetries(env).catch((err) => {
				log.error("scheduled.webhook_retries", { error: String(err) });
			}),
		);
		ctx.waitUntil(
			runTelegramDigest(env).catch((err) => {
				log.error("scheduled.telegram_digest", { error: String(err) });
			}),
		);
	},
};
