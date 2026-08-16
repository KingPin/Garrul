/**
 * The single source of truth for every environment name Garrul reads.
 *
 * Before this file existed the same list was maintained by hand in six
 * places — `src/index.ts` (the `Bindings` type), `release-manifest.json`,
 * the `wrangler secret put` comment block in `wrangler.example.toml`,
 * `.dev.vars.example`, `scripts/setup.sh`, and the §5 table in
 * `AGENTS-OPERATE.md` — and no two agreed. Secrets existed that setup.sh
 * never prompted for; `GITHUB_TOKEN` was missing from the release contract
 * entirely; and 20 plain `[vars]` were recorded in the manifest as secrets
 * because the generator classified by an inverted allowlist that silently
 * defaulted to "secret".
 *
 * Everything downstream is now generated from this array or checked
 * against it:
 *
 *   secrets.example.env      generated  (scripts/build-config.ts)
 *   .dev.vars.example        generated
 *   wrangler.example.toml    generated  ([secrets] block + pointer)
 *   scripts/setup.sh         generated  (secret prompts + next-steps vars)
 *   AGENTS-OPERATE.md §5     generated  (between BEGIN/END markers)
 *   release-manifest.json    generated  (scripts/upgrade/build-manifest.ts)
 *   src/index.ts Bindings    CHECKED    (parity assertion, see below)
 *
 * `Bindings` stays hand-written — it carries the prose that explains each
 * setting, and a generated type would lose that. Instead `build-manifest.ts`
 * asserts that the set of `string`-typed fields in `Bindings` is exactly the
 * set of names here. Adding a binding without registering it fails CI rather
 * than silently misclassifying it.
 *
 * To add a setting: add the field to `Bindings`, add an entry here, run
 * `npm run config:build && npm run manifest:build`, commit the result.
 */

export type ConfigKind = "secret" | "var";

export type ConfigEntry = {
	/** Env var name. Must match a `string` field in the `Bindings` type. */
	name: string;
	/**
	 * `secret` → `wrangler secret put` / `secret bulk`, encrypted at rest.
	 * `var`    → `wrangler.toml` `[vars]`, plaintext and visible in the
	 *            Cloudflare dashboard to anyone with account read access.
	 */
	kind: ConfigKind;
	/**
	 * Deploy fails / drift is reported when a required entry is absent.
	 * Only genuinely always-needed settings belong here — the OAuth pairs
	 * are per-provider optional, so an instance running GitHub-only login
	 * must not fail over a missing `DISCORD_CLIENT_SECRET`.
	 */
	required: boolean;
	/**
	 * The value shipped in wrangler.example.toml is a placeholder a human has to
	 * replace before deploying. Drives the "Next steps" list setup.sh prints.
	 *
	 * Deliberately distinct from `required`: that one drives deploy-time failure
	 * and drift reporting, and every var is `required: false` precisely because
	 * an unset var is never fatal. `mustEdit` is the other question — the var
	 * *is* set, to `https://comments.example.com`, and shipping that is worse
	 * than leaving it blank. Without a flag for it, setup.sh's next-steps list
	 * was hand-maintained and `config:check` stayed green while a newly added
	 * placeholder went unmentioned (issue #46).
	 *
	 * Vars only — secrets are covered by the setup.sh prompts. Never combine
	 * with `adminEditable`: DB > env means an admin save would beat a value the
	 * operator has to own, and these four are exactly the settings that can lock
	 * an operator out of the surface they'd use to undo it.
	 */
	mustEdit?: boolean;
	/** Section heading in generated templates. */
	group: string;
	/**
	 * Name of the secret that is worthless without this one, so setup.sh asks
	 * for both behind a single prompt. Set on the first half only.
	 *
	 * Declared rather than inferred from group size: an ID/secret pair really
	 * is all-or-nothing, but `TELEGRAM_BOT_TOKEN` and
	 * `TELEGRAM_WEBHOOK_SECRET` also make a group of two and are independently
	 * useful — the bot token alone enables outbound notifications, and the
	 * webhook secret is only needed for inbound commands. Collapsing them
	 * forced both prompts on anyone who answered yes and hid the second hint.
	 */
	pairWith?: string;
	/** One-line "where do I get this" shown above the template line. */
	hint: string;
	/** Prose for the AGENTS-OPERATE §5 table. */
	description: string;
	/** Example value for the §5 table. */
	example?: string;
	/**
	 * Override for the §5 table's "Where to set" cell. Only for entries where
	 * the plain secret/var answer needs a caveat.
	 */
	whereToSet?: string;
	/**
	 * The var is also a runtime setting: an admin can override it from Admin →
	 * Settings, which writes a `settings` row that beats this env var (see
	 * `src/lib/settings.ts` — precedence is DB > env > default). The env var
	 * remains the declared deploy-time default.
	 *
	 * Recorded here so the §5 table says so. Without it that table would drift
	 * into being the 7th hand-maintained config list, which is exactly what #42
	 * set out to kill.
	 *
	 * Only for `var` entries that genuinely cannot lock an operator out. Never
	 * mark a secret, `ENV`, `ALLOWED_ORIGINS`, `ADMIN_EMAILS`, or any URL that
	 * must match a registered OAuth redirect: DB > env means one bad admin save
	 * beats the operator's declared config, and the surface they'd use to undo it
	 * is the one they just broke.
	 */
	adminEditable?: boolean;
	/**
	 * Secrets setup.sh generates locally and streams straight into wrangler,
	 * so the value never touches disk. Excluded from secrets.example.env.
	 */
	generate?: "random32";
	/** Value written into .dev.vars.example. Omit for `""`. */
	devPlaceholder?: string;
	/**
	 * Replaces `hint` in .dev.vars.example. For entries where the production
	 * answer is actively wrong locally — `hint` tells an operator where to get
	 * the real credential, which is the opposite of what a local dev wants when
	 * `devPlaceholder` ships a purpose-built test value.
	 *
	 * Newlines become separate comment lines, so a doc link can follow the
	 * sentence it belongs to.
	 */
	devHint?: string;
	/** Release that introduced the setting. Feeds manifest `addedIn`. */
	addedIn: string;
};

const SECRET_TARGET = "`wrangler secret put` / `.dev.vars`";
const VAR_TARGET = "`wrangler.toml`";
const ADMIN_EDITABLE_TARGET =
	"`wrangler.toml` default; **Admin → Settings** overrides";
const MUST_EDIT_TARGET =
	"`wrangler.toml` — **replace the shipped placeholder before deploying**";

export const CONFIG_REGISTRY: ConfigEntry[] = [
	// ---------------------------------------------------------------- core
	{
		name: "ENV",
		kind: "var",
		required: false,
		group: "Core",
		hint: 'set to "production" for a deployed instance',
		description:
			"Switches dev affordances (CORS open, cookies `SameSite=Lax`). Production must be `production`.",
		example: "production",
		devPlaceholder: "dev",
		devHint:
			'"dev" locally, and the one value a local clone genuinely cannot run without.\nwrangler.example.toml ships ENV = "production" plus a placeholder\nALLOWED_ORIGINS, so without this override every /api/* request from\nlocalhost is rejected by the Origin gate (src/lib/cors.ts) and the widget\nnever loads. Do not carry this file to a deployed instance.',
		addedIn: "1.0.0",
	},
	{
		name: "ALLOWED_ORIGINS",
		kind: "var",
		required: false,
		mustEdit: true,
		group: "Core",
		hint: "comma-separated origins allowed to embed and call /api/*",
		description:
			"Comma-separated origins allowed to embed + call `/api/*`. Doubles as the CSRF `Origin` allowlist. See section 6.",
		example: "https://yourblog.example.com",
		addedIn: "1.0.0",
	},
	{
		name: "ADMIN_EMAILS",
		kind: "var",
		required: false,
		mustEdit: true,
		group: "Core",
		hint: "comma-separated emails that get auto-admin on OAuth signup",
		description:
			"Comma-separated emails. OAuth signups matching get auto-admin.",
		example: "you@example.com",
		addedIn: "1.0.0",
	},
	{
		name: "EDIT_WINDOW_MINUTES",
		kind: "var",
		required: false,
		group: "Core",
		adminEditable: true,
		hint: "minutes a commenter can edit their own post",
		description:
			"Minutes a commenter can edit their own post. Default 15; `0` disables editing.",
		example: "15",
		addedIn: "1.0.0",
	},
	{
		name: "PUBLIC_BASE_URL",
		kind: "var",
		required: false,
		mustEdit: true,
		group: "Core",
		hint: "public URL of this Worker; used in permalinks and email bodies",
		description:
			"Public URL of the Worker; used in permalinks + email bodies.",
		example: "https://comments.example.com",
		addedIn: "1.0.0",
	},
	{
		name: "CANONICAL_URL",
		kind: "var",
		required: false,
		group: "Core",
		hint: "only if the inbound Host differs from your canonical address",
		description:
			"Optional. Override for the public URL used by the `/AGENTS.md` route when the inbound `Host` differs from the canonical address.",
		example: "https://comments.example.com",
		addedIn: "1.0.0",
	},
	{
		name: "OAUTH_CALLBACK_BASE",
		kind: "var",
		required: false,
		mustEdit: true,
		group: "Core",
		hint: "must match the redirect URI registered with each provider",
		description:
			"Base URL for OAuth callbacks; must match the URI registered with each provider. Usually identical to `PUBLIC_BASE_URL`.",
		example: "https://comments.example.com",
		addedIn: "1.0.0",
	},
	{
		name: "BRANDING_HIDDEN",
		kind: "var",
		required: false,
		group: "Core",
		hint: 'set to "1" or "true" to hide the "Powered by Garrul" line',
		description:
			'Optional. Set to `1`/`true` to suppress the "Powered by Garrul" attribution under the comment list. Unset = attribution shown.',
		example: "false",
		addedIn: "1.0.0",
	},

	// ------------------------------------------------- generated secrets
	{
		name: "JWT_SECRET",
		kind: "secret",
		required: true,
		group: "Generated secrets",
		hint: "auto-generated 32-byte HMAC key for signed OAuth state",
		description:
			"HMAC-SHA-256 key for the signed OAuth state cookie (`src/lib/oauth.ts`). Required for sign-in to work at all. Rotating it invalidates any OAuth flow already in progress — users retry and it works; no other effect, since sessions are KV-backed and not signed with this.",
		example: "`openssl rand -base64 32` output",
		generate: "random32",
		devPlaceholder: "dev-jwt-secret-change-me",
		addedIn: "1.0.0",
	},
	{
		name: "IP_HASH_SECRET",
		kind: "secret",
		required: true,
		group: "Generated secrets",
		hint: "auto-generated HMAC pepper — generate once and keep it",
		description:
			"HMAC-SHA-256 pepper for IP hashing (see `src/lib/ip-hash.ts`). Never log/store raw IPs. Tier-1 secret: with it, a D1 export discloses every commenter's IPv4 address, so guard it like `JWT_SECRET`. Rotating invalidates existing rate-limit and dedupe buckets, orphans anonymous ghost identities, and does **not** re-key hashes already stored — read `docs/ip-hashing.md` before rotating.",
		example: "`openssl rand -base64 32` output",
		generate: "random32",
		devPlaceholder: "dev-ip-hash-pepper-change-me",
		addedIn: "1.0.0",
	},
	{
		name: "TURNSTILE_SITE_KEY",
		kind: "secret",
		required: true,
		group: "Turnstile",
		pairWith: "TURNSTILE_SECRET",
		hint: "from dash.cloudflare.com → Turnstile",
		description:
			"Cloudflare Turnstile site key. Required for anonymous commenting. Note this value is *public* — it ships in the widget HTML. It is stored as a secret for historical reasons and because doing so is harmless.",
		example: "0x4AAAAAAA...",
		devPlaceholder: "1x00000000000000000000AA",
		devHint:
			'Cloudflare\'s "always passes" testing site key — not your real one.\nhttps://developers.cloudflare.com/turnstile/troubleshooting/testing/',
		addedIn: "1.0.0",
	},
	{
		name: "TURNSTILE_SECRET",
		kind: "secret",
		required: true,
		group: "Turnstile",
		hint: "from dash.cloudflare.com → Turnstile",
		description: "Turnstile secret. Server-side token verification.",
		example: "0x4AAAAAAA...",
		devPlaceholder: "1x0000000000000000000000000000000AA",
		devHint: 'the matching "always passes" testing secret',
		addedIn: "1.0.0",
	},

	// --------------------------------------------------------------- oauth
	{
		name: "GH_CLIENT_ID",
		kind: "secret",
		required: false,
		group: "GitHub OAuth",
		pairWith: "GH_CLIENT_SECRET",
		hint: "from github.com/settings/developers",
		description: "GitHub OAuth client ID. Required for GitHub sign-in.",
		example: "Iv1.abcdef...",
		addedIn: "1.0.0",
	},
	{
		name: "GH_CLIENT_SECRET",
		kind: "secret",
		required: false,
		group: "GitHub OAuth",
		hint: "from github.com/settings/developers",
		description: "GitHub OAuth client secret.",
		example: "ghp_...",
		addedIn: "1.0.0",
	},
	{
		name: "GOOGLE_CLIENT_ID",
		kind: "secret",
		required: false,
		group: "Google OAuth",
		pairWith: "GOOGLE_CLIENT_SECRET",
		hint: "from console.cloud.google.com → OAuth credentials",
		description: "Google OAuth client ID. Required for Google sign-in.",
		example: "1234.apps.googleusercontent.com",
		addedIn: "1.0.0",
	},
	{
		name: "GOOGLE_CLIENT_SECRET",
		kind: "secret",
		required: false,
		group: "Google OAuth",
		hint: "from console.cloud.google.com → OAuth credentials",
		description: "Google OAuth client secret.",
		example: "GOCSPX-...",
		addedIn: "1.0.0",
	},
	{
		name: "FACEBOOK_CLIENT_ID",
		kind: "secret",
		required: false,
		group: "Facebook OAuth",
		pairWith: "FACEBOOK_CLIENT_SECRET",
		hint: "from developers.facebook.com → Facebook Login",
		description:
			"Optional. Facebook OAuth client ID from developers.facebook.com. Required for Facebook sign-in. Added v1.13.0.",
		example: "1234567890123456",
		addedIn: "1.13.0",
	},
	{
		name: "FACEBOOK_CLIENT_SECRET",
		kind: "secret",
		required: false,
		group: "Facebook OAuth",
		hint: "from developers.facebook.com → Facebook Login",
		description: "Optional. Facebook OAuth client secret.",
		example: "...",
		addedIn: "1.13.0",
	},
	{
		name: "TWITTER_CLIENT_ID",
		kind: "secret",
		required: false,
		group: "X/Twitter OAuth",
		pairWith: "TWITTER_CLIENT_SECRET",
		hint: "from developer.x.com → OAuth 2.0 (returns no email)",
		description:
			"Optional. X (Twitter) OAuth 2.0 client ID from developer.x.com. Required for X sign-in; the provider slug stays `twitter`. Added v1.13.0.",
		example: "...",
		addedIn: "1.13.0",
	},
	{
		name: "TWITTER_CLIENT_SECRET",
		kind: "secret",
		required: false,
		group: "X/Twitter OAuth",
		hint: "from developer.x.com → OAuth 2.0",
		description:
			"Optional. X (Twitter) OAuth 2.0 client secret. Note X returns no email — those users get a null email and no digest notifications.",
		example: "...",
		addedIn: "1.13.0",
	},
	{
		name: "DISCORD_CLIENT_ID",
		kind: "secret",
		required: false,
		group: "Discord OAuth",
		pairWith: "DISCORD_CLIENT_SECRET",
		hint: "from discord.com/developers → OAuth2",
		description:
			"Optional. Discord OAuth client ID from discord.com/developers → OAuth2. Required for Discord sign-in. Added v1.13.0.",
		example: "...",
		addedIn: "1.13.0",
	},
	{
		name: "DISCORD_CLIENT_SECRET",
		kind: "secret",
		required: false,
		group: "Discord OAuth",
		hint: "from discord.com/developers → OAuth2",
		description: "Optional. Discord OAuth client secret.",
		example: "...",
		addedIn: "1.13.0",
	},

	// --------------------------------------------------------------- email
	{
		name: "EMAIL_PROVIDER",
		kind: "var",
		required: false,
		group: "Email",
		hint: '"resend" is the only v1 adapter; unset disables sends',
		description:
			"Adapter selector. `resend` is the only v1 value. Unset disables sends.",
		example: "resend",
		addedIn: "1.0.0",
	},
	{
		name: "EMAIL_FROM",
		kind: "var",
		required: false,
		group: "Email",
		hint: "domain must be verified in Resend",
		description:
			"`From:` header for digest emails. Domain must be verified in the provider.",
		example: "Garrul <comments@example.com>",
		addedIn: "1.0.0",
	},
	{
		name: "RESEND_API_KEY",
		kind: "secret",
		required: false,
		group: "Email",
		hint: "from resend.com/api-keys",
		description:
			"Resend API key. Required when `EMAIL_PROVIDER=resend`.",
		example: "re_...",
		addedIn: "1.0.0",
	},
	{
		name: "CONFIRM_SEND_BURST_MAX",
		kind: "var",
		required: false,
		group: "Email",
		adminEditable: true,
		hint: "confirmation emails allowed per minute (global)",
		description:
			"Ceiling on outbound subscription-confirmation email per 60-second window, counted atomically in D1 and applied **globally** rather than per identity — every per-identity key on that endpoint is either racy or attacker-supplied. Default `20`, range `[1, 10000]`. Raise it if `wrangler tail` shows `confirmation email budget exhausted` while a busy post is being subscribed to legitimately; the exhausted window 429s new subscriptions but never touches already-confirmed subscribers. See `docs/ANTISPAM.md`.",
		example: "20",
		addedIn: "2.8.0",
	},
	{
		name: "CONFIRM_SEND_DAILY_MAX",
		kind: "var",
		required: false,
		group: "Email",
		adminEditable: true,
		hint: "confirmation emails allowed per day (global)",
		description:
			"Ceiling on outbound subscription-confirmation email per 24-hour window, same global D1 counter as `CONFIRM_SEND_BURST_MAX`. Default `200`, range `[1, 100000]`. The default sits deliberately *above* Resend's free-tier 100/day so the provider's limit is what a normal instance meets first; lower it to `100` (or below) if you would rather Garrul stop sending before your mail plan does. See `docs/ANTISPAM.md`.",
		example: "200",
		addedIn: "2.8.0",
	},

	// ------------------------------------------------------------ webhooks
	{
		name: "WEBHOOK_URL",
		kind: "secret",
		required: false,
		group: "Webhooks",
		hint: "legacy single-URL webhook; prefer /admin/webhooks endpoints",
		description:
			"Legacy single-URL webhook (fire-and-forget, no retries). Only honored when no endpoints are configured on `/admin/webhooks` — prefer endpoint rows (signed, retried, per-event filters).",
		example: "https://example.com/hook",
		addedIn: "1.0.0",
	},

	// ------------------------------------------------------------ telegram
	{
		name: "TELEGRAM_BOT_TOKEN",
		kind: "secret",
		required: false,
		group: "Telegram operator bot",
		hint: "BotFather token; see docs/telegram.md",
		description:
			"Optional. BotFather token enabling the Telegram operator bot. With only this set, outbound notifications work (add a `telegram` webhook endpoint with a chat id). Unset = feature off. See `docs/telegram.md`.",
		example: "123456789:AAH...",
		addedIn: "1.17.0",
	},
	{
		name: "TELEGRAM_WEBHOOK_SECRET",
		kind: "secret",
		required: false,
		group: "Telegram operator bot",
		hint: "shared secret for setWebhook; required for inbound commands",
		description:
			"Optional. Shared secret echoed in the `X-Telegram-Bot-Api-Secret-Token` header; required for inbound buttons/slash commands. Pass it to Telegram's `setWebhook` as `secret_token`. Unset = inbound rejected (fail closed).",
		example: "`openssl rand -base64 32` output",
		addedIn: "1.17.0",
	},
	{
		name: "TELEGRAM_BOT_USERNAME",
		kind: "var",
		required: false,
		group: "Telegram operator bot",
		hint: "the bot's @username, without the @",
		description:
			"Optional. Bot `@username` (without `@`). When set, `/admin/telegram` renders a one-tap `t.me/<bot>?start=<code>` deep link instead of manual `/start` steps.",
		example: "YourGarrulBot",
		addedIn: "1.17.0",
	},

	// ----------------------------------------------------------- anti-spam
	{
		name: "SPAM_PROVIDER",
		kind: "var",
		required: false,
		group: "Anti-spam",
		hint: '"akismet" or "workers-ai"; unset for none',
		description:
			'Optional. Pluggable content classifier — `akismet` or `workers-ai`. Unset = no classifier. `workers-ai` also needs an `[ai]` binding. See `docs/ANTISPAM.md`.',
		example: "akismet",
		addedIn: "1.1.1",
	},
	{
		name: "AKISMET_API_KEY",
		kind: "secret",
		required: false,
		group: "Anti-spam",
		hint: 'required when SPAM_PROVIDER = "akismet"',
		description:
			"Optional. Akismet API key. Required when `SPAM_PROVIDER=akismet`.",
		example: "...",
		addedIn: "1.1.1",
	},
	{
		name: "AKISMET_SITE_URL",
		kind: "secret",
		required: false,
		group: "Anti-spam",
		hint: "public site URL registered with Akismet",
		description:
			"Optional. Public site URL sent to Akismet alongside each check. Required when `SPAM_PROVIDER=akismet`.",
		example: "https://yourblog.example.com",
		addedIn: "1.1.1",
	},
	{
		name: "SPAM_FORM_TS_SECRET",
		kind: "secret",
		required: false,
		group: "Anti-spam",
		hint: "HMAC key for signed form-timestamp tokens",
		description:
			"Optional. HMAC key for signed form-timestamp tokens. Set when `SPAM_HONEYPOT_MIN_MS` is in use, otherwise the timing check cannot be trusted.",
		example: "`openssl rand -base64 32` output",
		addedIn: "1.1.1",
	},
	{
		name: "SPAM_BLOCKLIST",
		kind: "var",
		required: false,
		group: "Anti-spam",
		adminEditable: true,
		hint: "muted words, one term per line",
		description:
			"Optional. Muted-words list, one term per line. A term matches whole words only (`ass` does not flag \"class\"); wrap it in `*` to match anywhere (`*casino*`), or trail one for a prefix (`t.me/*`). Matching is case-insensitive, folds Unicode lookalike forms (fullwidth `ｖｉａｇｒａ` matches `viagra`) and ignores zero-width characters. Accents are *not* stripped and leetspeak is *not* decoded. Lines starting with `#` are comments. Not a regex — `.` and `(` are literal text. Checked against the comment body, author name and page URL; a hit routes the comment to the admin queue, never a silent drop. Usually maintained on the Settings page rather than here — this is the default a fresh deploy starts with.",
		example: "casino\\n*viagra*\\nt.me/*",
		addedIn: "2.12.0",
	},
	{
		name: "SPAM_LINK_THRESHOLD",
		kind: "var",
		required: false,
		group: "Anti-spam",
		adminEditable: true,
		hint: "flag if more than N URLs in a comment body",
		description:
			"Optional. Flag a comment to `pending` when it contains more than N URLs. Unset (or `-1`) = off; `0` flags any comment containing a link. Tripped signals never silently drop a comment — they route it to the admin queue.",
		example: "3",
		addedIn: "1.1.1",
	},
	{
		name: "SPAM_HONEYPOT_MIN_MS",
		kind: "var",
		required: false,
		group: "Anti-spam",
		adminEditable: true,
		hint: "flag if the form was submitted faster than N ms",
		description:
			"Optional. Flag a comment to `pending` when the form was submitted faster than N milliseconds. Pair with `SPAM_FORM_TS_SECRET` — without it the timestamp is unsigned and the check is skipped. Unset or `0` = off.",
		example: "1500",
		addedIn: "1.1.1",
	},
	{
		name: "SPAM_FIRST_COMMENT_MODERATE",
		kind: "var",
		required: false,
		group: "Anti-spam",
		adminEditable: true,
		hint: "first comment from a new author goes to the queue",
		description:
			"Optional. Route the first comment from any new author to `pending`. Unset = off.",
		example: "true",
		addedIn: "1.1.1",
	},

	// ----------------------------------------------------- usage dashboard
	{
		name: "CF_ACCOUNT_ID",
		kind: "var",
		required: false,
		group: "Cloudflare usage dashboard",
		hint: "paired with CF_API_TOKEN to enable /admin/usage",
		description:
			"Optional. Cloudflare account ID; paired with `CF_API_TOKEN` to enable the `/admin/usage` analytics page.",
		example: "0123abcd...",
		whereToSet:
			"`wrangler.toml` (or `wrangler secret put` — the in-app setup guide uses the secret form; both work)",
		addedIn: "1.8.0",
	},
	{
		name: "CF_API_TOKEN",
		kind: "secret",
		required: false,
		group: "Cloudflare usage dashboard",
		hint: "Analytics-read token; scopes in AGENTS-OPERATE §5",
		description:
			"Optional. Cloudflare API token for `/admin/usage`. Least-privilege scopes: Account.Analytics:Read, Account.D1:Read, Account.Workers KV Storage:Read. The page renders setup instructions when either value is unset.",
		example: "...",
		addedIn: "1.8.0",
	},

	// ------------------------------------------------------- update checks
	{
		name: "GITHUB_TOKEN",
		kind: "secret",
		required: false,
		group: "Update checks",
		hint: "read-only public_repo token; raises the 60 req/hr cap",
		description:
			'Optional. Raises the GitHub API rate limit for the `/admin/*` "update available" check. Unauthenticated calls allow 60 req/hr per IP and Cloudflare egress IPs are shared across colos. Read-only `public_repo` scope is sufficient.',
		example: "ghp_...",
		addedIn: "1.21.0",
	},

	// ------------------------------------------------------- feature flags
	{
		name: "COMMENTS_ENABLED",
		kind: "var",
		required: false,
		group: "Feature flags",
		hint: "master switch for new comment creation; defaults on",
		description:
			'Master switch for new comment creation. Defaults **on**; set `0`/`false`/`no`/`off` to close commenting instance-wide (existing comments stay visible read-only, the widget shows a "Comments are closed." notice, and `POST /api/v1/comments` returns 403).',
		example: "true",
		addedIn: "1.10.0",
	},
	{
		name: "REACTIONS_ENABLED",
		kind: "var",
		required: false,
		group: "Feature flags",
		hint: "comment emoji reactions; defaults on",
		description:
			"Comment emoji reactions. Defaults **on**; same falsy-spelling semantics. Disabling hides the reaction bar and 403s `POST /api/v1/reactions`.",
		example: "true",
		addedIn: "1.10.0",
	},
	{
		name: "VOTING_ENABLED",
		kind: "var",
		required: false,
		group: "Feature flags",
		hint: "comment up/down voting; defaults on",
		description:
			"Comment voting (up/down buttons in the widget). Defaults **on** when unset; set `0`/`false`/`no`/`off` to disable instance-wide.",
		example: "true",
		addedIn: "1.8.0",
	},
	{
		name: "DOWNVOTES_ENABLED",
		kind: "var",
		required: false,
		group: "Feature flags",
		hint: "downvote button; defaults on",
		description:
			"Downvote button. Same defaults-on semantics. Applies to **both** comment votes and page votes (a brigading-mitigation switch); independent of `VOTING_ENABLED`.",
		example: "true",
		addedIn: "1.8.0",
	},
	{
		name: "MODERATOR_EMAIL_ENABLED",
		kind: "var",
		required: false,
		group: "Feature flags",
		hint: "email the operator about the moderation queue; defaults OFF",
		description:
			"Email `ADMIN_EMAILS` (or `MODERATOR_NOTIFY_EMAILS`) a digest when comments land in the moderation queue or get reported. Defaults **off** — outbound mail is not something an upgrade should start doing unasked. Needs `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM` and `PUBLIC_BASE_URL`; without them the pass is a silent no-op. Also settable from `/admin/settings`.",
		example: "false",
		addedIn: "2.9.0",
	},
	{
		name: "MODERATOR_NOTIFY_EMAILS",
		kind: "var",
		required: false,
		group: "Feature flags",
		hint: "comma-separated recipients for moderation email; defaults to ADMIN_EMAILS",
		description:
			"Comma-separated recipients for moderation-queue email. Unset falls back to `ADMIN_EMAILS`, which is already the set of people who can act on the queue — set this only when the alerts belong somewhere else, such as a shared `moderation@` alias.",
		example: "moderation@example.com",
		addedIn: "2.9.0",
	},
	{
		name: "PAGE_REACTIONS_ENABLED",
		kind: "var",
		required: false,
		group: "Feature flags",
		hint: "article-level reaction bar; defaults OFF",
		description:
			"Article-level emoji reaction bar (react to the page itself, no comment). Defaults **off** so an upgrade never surfaces new UI unasked. Enables `POST /api/v1/page-engagement/reactions` and the widget bar.",
		example: "false",
		addedIn: "1.10.0",
	},
	{
		name: "PAGE_VOTES_ENABLED",
		kind: "var",
		required: false,
		group: "Feature flags",
		hint: 'article-level "was this helpful?" tally; defaults OFF',
		description:
			'Article-level "was this helpful?" up/down vote tally. Defaults **off**. Enables `POST /api/v1/page-engagement/votes`; downvotes here still honor `DOWNVOTES_ENABLED`.',
		example: "false",
		addedIn: "1.10.0",
	},
	{
		name: "SHOW_DELETED_PLACEHOLDERS",
		kind: "var",
		required: false,
		group: "Feature flags",
		hint: "keep deleted comments as placeholders; defaults OFF",
		description:
			"Keep deleted comments in the public tree as a placeholder (`[deleted]` / `[removed by a moderator]`) instead of pruning leaf deletions. Defaults **off** (current behavior: a deleted comment with live replies is still kept for thread continuity; a deleted leaf is dropped). Added v1.15.0.",
		example: "false",
		addedIn: "1.15.0",
	},

	// -------------------------------------------------- display/pagination
	{
		name: "COMMENTS_PER_PAGE",
		kind: "var",
		required: false,
		group: "Display & pagination",
		hint: "top-level comments per load (default 25, range 1-200)",
		description:
			'Top-level comments shown per initial load and per "Load older comments" click (server-side slice in `api.comments.ts`). Defaults **25**; clamped to `[1, 200]`. **Behavior change in v1.11.0:** older installs rendered up to 100 at once — set this to `100` to restore that.',
		example: "25",
		addedIn: "1.10.0",
	},
	{
		name: "REPLIES_PER_THREAD",
		kind: "var",
		required: false,
		group: "Display & pagination",
		hint: 'replies per parent before "Show N more" (0 = all)',
		description:
			'Replies shown under each comment before a "Show N more replies" button (widget). `0` = show all. Defaults **3**; clamped to `[0, 100]`.',
		example: "3",
		addedIn: "1.10.0",
	},
	{
		name: "DEFAULT_LOCALE",
		kind: "var",
		required: false,
		group: "Display & pagination",
		hint: "language for the widget, feed and emails (auto = follow the host page)",
		description:
			"Language the widget, the Atom feed and notification emails render in. `auto` (the default) means *not configured*, which lets the host page's `<html lang>` pick one; set an explicit tag to override the page. Accepts `auto` plus any locale Garrul ships — see the locale table in the README. An unknown tag falls back to `auto`. Machine-seeded translations are never selected from `<html lang>`; reaching one requires either this setting or `data-lang` on the embed. Comment text itself is never translated.",
		example: "auto",
		adminEditable: true,
		addedIn: "2.7.0",
	},
	{
		name: "AUTO_COLLAPSE_DEPTH",
		kind: "var",
		required: false,
		group: "Display & pagination",
		hint: "replies at this depth start collapsed (0 = never)",
		description:
			"Replies nested at this depth or deeper start collapsed in the widget. `0` = never auto-collapse. Defaults **3**; clamped to `[0, 4]` (the display flatten threshold — *not* the 8-level reply cap).",
		example: "3",
		addedIn: "1.10.0",
	},

	// ---------------------------------------------------- thread lifecycle
	{
		name: "AUTO_CLOSE_DAYS",
		kind: "var",
		required: false,
		group: "Thread lifecycle",
		hint: "close threads N days after publish (0 = disabled)",
		description:
			"Close a thread this many days after its article was published (`posts.published_at`, else `created_at`). Evaluated lazily at read/write time — no cron. Defaults **0** (disabled). Existing comments, reactions and votes stay live.",
		example: "0",
		addedIn: "1.17.0",
	},
	{
		name: "AUTO_CLOSE_AT",
		kind: "var",
		required: false,
		group: "Thread lifecycle",
		hint: "hard sunset: close ALL threads at this epoch-ms (0 = off)",
		description:
			"Hard sunset — close **all** threads at/after this epoch-ms timestamp. Defaults **0** (disabled). The admin Settings page writes this via a date picker.",
		example: "0",
		addedIn: "1.17.0",
	},
	{
		name: "COMMUNITY_MIN_VOTES",
		kind: "var",
		required: false,
		group: "Thread lifecycle",
		hint: "brigading floor before the collapse ratio applies",
		description:
			"Minimum total votes before `COMMUNITY_COLLAPSE_RATIO` applies — the brigading floor. Defaults **5**.",
		example: "5",
		addedIn: "1.17.0",
	},
	{
		name: "COMMUNITY_COLLAPSE_RATIO",
		kind: "var",
		required: false,
		group: "Thread lifecycle",
		hint: "percent downvotes that folds a comment (0 = off)",
		description:
			"Percent of downvotes/total that collapses a comment in the widget. Cosmetic and reversible — the reader can expand it. `0` = off, range `[0, 100]`. Requires `DOWNVOTES_ENABLED`.",
		example: "0",
		addedIn: "1.17.0",
	},
	{
		name: "IP_HASH_RETENTION_DAYS",
		kind: "var",
		required: false,
		group: "Privacy",
		hint: "clear stored ip_hash after N days (0 = keep forever)",
		description:
			"Clear `comments.ip_hash` + `comments.user_agent` and `reports.reporter_ip_hash` once the row is this many days old, swept by the cron. `0` = off (the default — an upgrade never starts deleting data on its own). Range `[0, 3650]`, and the sweep refuses to run below **7** days so a fat-fingered `1` can't purge nearly everything. **Irreversible**: nothing reconstructs a cleared hash. Does *not* touch anonymous ghost `users.provider_id` — that column is the identity itself, so expiring it would delete the account rather than a hash. See `docs/ip-hashing.md`.",
		example: "0",
		addedIn: "2.1.0",
	},
	{
		name: "AUDIT_LOG_RETENTION_DAYS",
		kind: "var",
		required: false,
		group: "Privacy",
		hint: "delete audit_log rows after N days (0 = keep forever)",
		description:
			"Delete `audit_log` rows once they are this many days old, swept by the cron. `0` = off (the default — an upgrade never starts deleting an operator's moderation history on its own). Range `[0, 3650]`, and the sweep refuses to run below **30** days, a higher floor than the IP sweep's because a moderation record stays operationally useful far longer than a hashed IP. **Irreversible** — a pruned audit row is gone, and with it the answer to \"why is this user banned\". Whole rows are deleted rather than redacted: an audit entry with the actor removed reads as evidence while proving nothing. See `docs/compliance/data-inventory.md`.",
		example: "0",
		addedIn: "2.6.0",
	},
];

/** Secrets, in registry order. */
export const SECRETS = CONFIG_REGISTRY.filter((e) => e.kind === "secret");

/** Plain `[vars]`, in registry order. */
export const VARS = CONFIG_REGISTRY.filter((e) => e.kind === "var");

/**
 * Vars whose shipped value is a placeholder. Feeds the "Next steps" list
 * setup.sh prints after a first install — see `mustEdit`.
 */
export const MUST_EDIT_VARS = VARS.filter((e) => e.mustEdit);

/**
 * Names for wrangler's `secrets.required` config property. Deliberately
 * only the always-required secrets — the OAuth pairs are optional per
 * provider, so listing them would fail deploys for GitHub-only installs.
 */
export const REQUIRED_SECRET_NAMES = SECRETS.filter((e) => e.required).map(
	(e) => e.name,
);

/**
 * Secrets setup.sh generates and streams directly into wrangler. These are
 * omitted from secrets.example.env so operators are never nudged into
 * writing them to disk.
 */
export const GENERATED_SECRET_NAMES = SECRETS.filter((e) => e.generate).map(
	(e) => e.name,
);

/**
 * Where the §5 table tells operators to set a given entry. An explicit
 * `whereToSet` still wins — it exists for entries whose answer needs a caveat
 * the generic branches can't express.
 */
export const targetFor = (e: ConfigEntry): string =>
	e.whereToSet ??
	(e.kind === "secret"
		? SECRET_TARGET
		: e.adminEditable
			? ADMIN_EDITABLE_TARGET
			: e.mustEdit
				? MUST_EDIT_TARGET
				: VAR_TARGET);

/** Registry order, grouped, preserving first-seen group order. */
export const groupsOf = (entries: ConfigEntry[]): [string, ConfigEntry[]][] => {
	const out = new Map<string, ConfigEntry[]>();
	for (const e of entries) {
		const bucket = out.get(e.group);
		if (bucket) bucket.push(e);
		else out.set(e.group, [e]);
	}
	return [...out.entries()];
};

export const byName = (name: string): ConfigEntry | undefined =>
	CONFIG_REGISTRY.find((e) => e.name === name);
