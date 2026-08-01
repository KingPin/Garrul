/**
 * /api/v1/comments — anonymous comment CRUD.
 *
 * M2 scope: anonymous-only path. OAuth (M5) will add a branch that skips
 * Turnstile + uses the session user_id instead of a ghost user.
 *
 * Routes:
 *   POST   /api/v1/comments              create
 *   GET    /api/v1/comments?slug=<slug>  list (flat; tree assembled M4)
 *   PATCH  /api/v1/comments/:id          edit (within edit_window_minutes)
 *   DELETE /api/v1/comments/:id          soft-delete
 *
 * Auth:
 *   - Anonymous identity = ghost user keyed on hashed-IP (lib/db/queries.ts).
 *   - Session cookie holds user_id; cookie ⇒ KV-resolved ⇒ user_id check.
 *   - Anonymous POST requires Turnstile; rate-limited per-IP-hash.
 *
 * Body is sanitized to HTML and stored alongside the raw markdown so the
 * sanitizer can be re-run via scripts/rerender.ts (renderer_version bump).
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import {
	adminInsertSpamVerdict,
	enqueueNotification,
	getOrCreateGhost,
	getComment,
	getPost,
	getUserVotesOnPost,
	insertComment,
	isUserRole,
	listActiveSubscriptionsForPost,
	listCommentsForThreads,
	listReactionsForPost,
	listThreadRefsForPost,
	listUserReactionsOnPost,
	softDeleteComment,
	TREE_ROW_LIMIT,
	updateCommentBody,
	upsertPost,
	type Comment,
	type SpamVerdictSource,
	type SpamVerdictValue,
	type TreeComment,
	type User,
} from "../db/queries";
import { identiconSvg } from "../lib/identicon";
import { sanitizePostTitle } from "../lib/post-title";
import { clientIp, hashIp } from "../lib/ip-hash";
import { CURRENT_RENDERER_VERSION, renderMarkdown, validateBody } from "../lib/markdown";
import { checkRateLimit } from "../lib/ratelimit";
import { requireActiveUser } from "../lib/active-user";
import { readSession } from "../lib/session";
import { verifyTurnstile } from "../lib/turnstile";
import { writeEvent } from "../lib/analytics";
import { fireWebhook } from "../lib/webhook";
import {
	loadFlags,
	loadNumbers,
	type ResolvedFlags,
	type ResolvedNumbers,
} from "../lib/settings";
import { resolveThreadOpen } from "../lib/thread";
import { bustTreeCache, TREE_CACHE_TTL, treeCacheKey } from "../lib/tree-cache";
import {
	cacheJson,
	jsonResponse,
	matchCache,
	tryWaitUntil,
} from "../lib/response-cache";
import { log } from "../lib/log";
import {
	countLinks,
	isFirstComment,
	signFormTimestamp,
	verifyFormTimestamp,
} from "../lib/spam/heuristics";
import { checkSpam } from "../lib/spam";
import type { CommentStatus } from "../db/queries";
import {
	buildTree,
	MAX_REPLY_DEPTH,
	type ReactionCount,
	type TreeAuthor,
	type TreeNode,
} from "../lib/tree";
import { t } from "../i18n";

type SessionVars = {
	userId: string | null;
	sessionId: string | null;
};

// D1 stores booleans as 0/1 INTEGER; we widen to a row type for `.first<…>()`
// and `.all<…>()` callsites that hit the users table directly, then convert
// at the boundary. (db/queries.ts has its own copy for its internal use.)
// `role` is widened to `string` because D1 returns the raw column value;
// we re-narrow at the boundary via isUserRole, falling back to "user" so a
// stale row with an unknown role can't crash the request.
type UserRow = Omit<User, "is_admin" | "is_banned" | "role"> & {
	is_admin: number;
	is_banned: number;
	role: string;
};

const rowToUser = (row: UserRow): User => ({
	...row,
	is_admin: row.is_admin === 1,
	is_banned: row.is_banned === 1,
	role: isUserRole(row.role) ? row.role : "user",
});

const comments = new Hono<{ Bindings: Bindings; Variables: SessionVars }>();

const MAX_NAME = 40;
const SLUG_RE = /^[a-zA-Z0-9_\-./]{1,200}$/;
const HONEYPOT_FIELD = "website";

// Signed-in writes get their own, looser budget. Signing in is a real cost to
// an attacker and a real signal about a reader, so the anonymous 1-per-10s
// floor would be a usability tax on the people most likely to be having an
// actual conversation. It is still a ceiling: unthrottled is what let one
// throwaway OAuth account drain D1's daily write quota.
//
// Own `scope` per the limiter's contract — a config only applies to the bucket
// it is passed with, so sharing "comment" would mean these caps were enforced
// against stamps written under the anonymous budget.
const AUTHED_COMMENT_LIMITS = {
	short: { max: 3, windowSec: 10 },
	long: { max: 60, windowSec: 600 },
};

// Edits and deletes are cheaper than a post (no spam evaluation, no
// notification fan-out) but still cost a D1 write plus a cache bust and an
// outbound webhook each, and neither had any limit at all.
const MUTATE_COMMENT_LIMITS = {
	short: { max: 5, windowSec: 10 },
	long: { max: 100, windowSec: 600 },
};

type CreateBody = {
	slug?: string;
	parent_id?: string | null;
	name?: string;
	body?: string;
	turnstile_token?: string;
	post_title?: string | null;
	post_url?: string | null;
	/** Host page's real publish time (epoch ms or ISO), from data-published. */
	post_published?: number | string | null;
	form_ts?: string;
	[HONEYPOT_FIELD]?: string;
};

// Upper bound for a host-supplied publish time (~year 2100), matching the
// auto_close_at clamp. A bogus far-future value would only ever DELAY that one
// post's age-based close, but reject out-of-range/garbage so it can't poison
// the anchor. Accepts epoch ms (number or numeric string) or an ISO date.
const PUBLISHED_AT_MAX = 4102444800000;
const parsePublishedAt = (raw: number | string | null | undefined): number | null => {
	if (raw == null) return null;
	let ms: number;
	if (typeof raw === "number") {
		ms = raw;
	} else {
		const s = raw.trim();
		if (!s) return null;
		ms = /^\d+$/.test(s) ? Number.parseInt(s, 10) : Date.parse(s);
	}
	if (!Number.isFinite(ms) || ms <= 0 || ms > PUBLISHED_AT_MAX) return null;
	return ms;
};

// Resolved edit window in ms. 0 minutes = editing disabled, and every caller
// compares an elapsed time against this, so a 0 window rejects unconditionally.
const editWindowMs = (numbers: ResolvedNumbers): number =>
	numbers.edit_window_minutes * 60_000;

// C0 controls + DEL + C1 controls, matching sanitizePostTitle's range so a name
// and a title can't disagree about what's storable.
const NAME_CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]", "g");

const validName = (raw: string | undefined): { ok: true; name: string } | { ok: false; key: "err.name.required" | "err.name.too_long"; max?: number } => {
	// Control characters go first: `.trim()` only removes whitespace, so a name
	// like "Bob" + U+0001 survived and made the Atom feed not well-formed, which
	// is a *fatal* XML error — every conforming reader drops the whole document.
	// feed.ts strips them again at serialization (OAuth display names never come
	// through here), but a stored name shouldn't carry them in the first place.
	const name = (raw ?? "").replace(NAME_CONTROL_CHARS, "").trim();
	if (!name) return { ok: false, key: "err.name.required" };
	if (name.length > MAX_NAME) return { ok: false, key: "err.name.too_long", max: MAX_NAME };
	return { ok: true, name };
};

const serializeComment = (c: Comment, author: User) => {
	const isDeleted = c.status === "deleted";
	return {
		id: c.id,
		post_slug: c.post_slug,
		parent_id: c.parent_id,
		body_html: isDeleted ? "" : c.body_html,
		status: c.status,
		edited_at: c.edited_at,
		deleted_at: c.deleted_at,
		deleted_by: isDeleted ? c.deleted_by : null,
		created_at: c.created_at,
		// No `is_admin` here either — see the TreeAuthor comment in lib/tree.ts.
		// This is the POST/PATCH echo of a single comment, but it's the same
		// public surface and the widget renders both through one code path.
		author: {
			id: author.id,
			name: author.name,
			provider: author.provider,
			avatar_svg: author.avatar_url ? null : identiconSvg(author.id),
			avatar_url: author.avatar_url,
		},
	};
};

/**
 * Mint a signed HMAC timestamp so the widget can prove how long the form was
 * displayed before submission. Verified server-side when both the resolved
 * `spam_honeypot_min_ms` setting is positive and `SPAM_FORM_TS_SECRET` is set.
 *
 * 404s when either is missing — the widget always asks for a token but
 * tolerates a missing one (the existing field-honeypot still applies),
 * and we don't want to expose an endpoint that signs tokens nothing
 * will ever check.
 */
comments.get("/form-token", async (c) => {
	const secret = c.env.SPAM_FORM_TS_SECRET;
	// Resolved, not raw env: an admin who turns honeypot timing on from the
	// Settings page needs this endpoint to start minting tokens immediately,
	// otherwise every submission arrives unsigned and the check it just enabled
	// flags nothing.
	const { spam_honeypot_min_ms: minMs } = await loadNumbers(c.env);
	if (!secret || minMs <= 0) {
		return c.json({ error: "not_found" }, 404);
	}
	const token = await signFormTimestamp(Date.now(), secret);
	return c.json({ token });
});

type PendingVerdict = {
	source: SpamVerdictSource;
	verdict: SpamVerdictValue;
	score: number | null;
	raw: Record<string, unknown> | null;
};

type SpamEvaluation = {
	status: CommentStatus;
	reasons: string[];
	verdicts: PendingVerdict[];
};

/**
 * Run the configured anti-spam signals against a candidate comment and
 * decide whether it goes in as `approved` or `pending`. The three heuristic
 * dials are runtime settings (DB override > env > default) so an operator can
 * retune them from the Settings page while watching the queue; `SPAM_PROVIDER`
 * and the credentials stay deploy-time. Admins skip the check entirely.
 * Heuristics run first and short-circuit the (potentially paid) classifier call.
 *
 * Per-source verdicts are surfaced alongside the routing decision so the
 * caller can persist them to spam_verdicts once the comment id is known
 * (see persistVerdicts).
 */
const evaluateSpam = async (
	env: Bindings,
	flags: ResolvedFlags,
	numbers: ResolvedNumbers,
	author: User,
	bodyMd: string,
	postUrl: string | null,
	userAgent: string | null,
	formTs: string | undefined,
	// The form-timing heuristic is a submission-time signal. An edit has no
	// freshly-rendered form and therefore no token to verify, and a *missing*
	// token flags — so on that path the check has to be skipped rather than
	// silently marking every edit as a bot.
	opts: { skipFormTs?: boolean } = {},
): Promise<SpamEvaluation> => {
	if (author.is_admin) return { status: "approved", reasons: [], verdicts: [] };
	const reasons: string[] = [];
	const verdicts: PendingVerdict[] = [];
	const heuristicsRaw: Record<string, unknown> = {};

	const minMs = numbers.spam_honeypot_min_ms;
	if (minMs > 0 && env.SPAM_FORM_TS_SECRET && !opts.skipFormTs) {
		const v = await verifyFormTimestamp(
			formTs,
			env.SPAM_FORM_TS_SECRET,
			Date.now(),
			minMs,
		);
		heuristicsRaw.form_ts = { flag: v.flag, reason: v.reason ?? null };
		if (v.flag) reasons.push(v.reason ?? "form_ts");
	}

	// -1 = disabled; 0 flags any comment carrying a link.
	const linkThreshold = numbers.spam_link_threshold;
	if (linkThreshold >= 0) {
		const n = countLinks(bodyMd);
		heuristicsRaw.link_count = { count: n, threshold: linkThreshold };
		if (n > linkThreshold) reasons.push(`link_count:${n}`);
	}

	// Compute is_first_comment if either the moderate-on-first heuristic
	// or the classifier is enabled — classifiers use it as a feature even
	// when the operator hasn't asked us to auto-moderate on it.
	const moderateFirst = flags.spam_first_comment_moderate;
	let isFirst = false;
	if (moderateFirst || env.SPAM_PROVIDER) {
		isFirst = await isFirstComment(env.DB, author.id);
		if (moderateFirst) {
			heuristicsRaw.first_comment = { is_first: isFirst };
			if (isFirst) reasons.push("first_comment");
		}
	}

	if (Object.keys(heuristicsRaw).length > 0) {
		verdicts.push({
			source: "heuristics",
			verdict: reasons.length > 0 ? "spam" : "ham",
			score: null,
			raw: heuristicsRaw,
		});
	}

	// Skip the classifier call when a heuristic already flagged — the
	// outcome is already `pending` and the call may cost money/latency.
	if (reasons.length === 0 && env.SPAM_PROVIDER) {
		const classifierVerdict = await checkSpam(env, {
			body_md: bodyMd,
			author_name: author.name,
			author_email: author.email,
			user_agent: userAgent,
			post_url: postUrl,
			is_first_comment: isFirst,
		});
		if (classifierVerdict) {
			const source: SpamVerdictSource =
				env.SPAM_PROVIDER === "akismet" ? "akismet" : "workers-ai";
			verdicts.push({
				source,
				verdict: classifierVerdict.spam ? "spam" : "ham",
				score: classifierVerdict.score ?? null,
				raw: classifierVerdict.raw ?? null,
			});
			if (classifierVerdict.spam) {
				reasons.push(classifierVerdict.reason ?? "classifier");
			}
		}
	}

	return reasons.length > 0
		? { status: "pending", reasons, verdicts }
		: { status: "approved", reasons: [], verdicts };
};

/**
 * Fire-and-forget verdict persistence. Each row is independently swallowed
 * on error — a slow or broken D1 must never crash comment submission.
 */
const persistVerdicts = async (
	db: D1Database,
	commentId: string,
	verdicts: PendingVerdict[],
): Promise<void> => {
	for (const v of verdicts) {
		try {
			await adminInsertSpamVerdict(db, {
				comment_id: commentId,
				source: v.source,
				verdict: v.verdict,
				score: v.score,
				raw: v.raw,
			});
		} catch (err) {
			log.warn("spam.verdict.persist_failed", {
				source: v.source,
				error: String(err),
			});
		}
	}
};

comments.post("/", async (c) => {
	const flags = await loadFlags(c.env);
	if (!flags.comments_enabled) {
		return c.json({ error: "comments_disabled" }, 403);
	}

	const body = await c.req.json<CreateBody>().catch(() => null);
	if (!body) return c.json({ error: t("err.internal") }, 400);

	if (body[HONEYPOT_FIELD]) {
		return c.json({ error: t("err.honeypot") }, 400);
	}

	const slug = (body.slug ?? "").trim();
	if (!slug) return c.json({ error: t("err.post.required") }, 400);
	if (!SLUG_RE.test(slug)) return c.json({ error: t("err.post.invalid") }, 400);

	const bodyCheck = validateBody(body.body ?? "");
	if (!bodyCheck.ok) {
		const args = bodyCheck.max != null ? { max: bodyCheck.max } : undefined;
		return c.json({ error: t(bodyCheck.key, args) }, 400);
	}

	const session = await readSession(c);

	// Anonymous path: name + Turnstile required on top of the rate limit.
	let author: User;
	const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_HASH_SECRET);

	// Both identities get metered, and on each path the budget is spent AFTER
	// the free local validation but BEFORE anything that costs a quota — the
	// Turnstile siteverify fetch, the ghost upsert, the insert.
	//
	// The check used to live inside the `!session` branch below, and *after* the
	// siteverify call. Two consequences: a signed-in caller fell straight
	// through to the insert unthrottled, so one throwaway OAuth account could
	// burn D1's 100k daily row-writes in minutes (every accepted comment costs
	// upsertPost + insertComment + bustTreeCache plus one enqueueNotification
	// write *per confirmed subscriber*); and the unauthenticated siteverify was
	// an unmetered outbound-fetch amplifier. Authentication raises the cost of
	// an attack; it doesn't remove the need for a ceiling.
	const enforceWriteBudget = async (): Promise<Response | null> => {
		const rl = await checkRateLimit(
			c.req.url,
			session ? `user:${session.user_id}` : ipHash,
			session
				? { scope: "comment-authed", config: AUTHED_COMMENT_LIMITS }
				: { scope: "comment" },
		);
		if (rl.ok) return null;
		writeEvent(c.env.ANALYTICS, "ratelimit.hit", {
			outcome: rl.reason ?? null,
			post_slug: slug,
		});
		return c.json({ error: t("err.ratelimit") }, 429);
	};

	if (!session) {
		// Name and token *presence* are checked first and deliberately cost
		// nothing: at 1 request per 10s, making a typo spend the caller's slot
		// would lock a legitimate reader out of their own retry.
		const nameCheck = validName(body.name);
		if (!nameCheck.ok) {
			const args = nameCheck.max != null ? { max: nameCheck.max } : undefined;
			return c.json({ error: t(nameCheck.key, args) }, 400);
		}

		if (!body.turnstile_token) {
			return c.json({ error: t("err.turnstile.required") }, 400);
		}

		const denied = await enforceWriteBudget();
		if (denied) return denied;

		// Turnstile binds the token to the hostname where the widget was
		// SOLVED. The widget renders inside our same-origin iframe at
		// GET /embed/turnstile-frame (the Shadow-DOM-dodging fix), so the
		// hostname Cloudflare stamps on the token is *this Worker's own
		// hostname* — not the embedding host page. Deriving expectedHostname
		// from the request URL is therefore correct here.
		let expectedHostname = new URL(c.req.url).hostname;
		// Cloudflare's "always passes" dev test keys return a fixed
		// data.hostname of "example.com" regardless of where the widget
		// actually rendered. Override under ENV=dev so local wrangler dev
		// (hostname=localhost) keeps exercising the hostname check.
		if (c.env.ENV === "dev") {
			expectedHostname = "example.com";
		}
		const ts = await verifyTurnstile(
			body.turnstile_token,
			c.env.TURNSTILE_SECRET,
			{
				clientIp: clientIp(c.req.raw),
				expectedHostname,
			},
		);
		if (!ts) return c.json({ error: t("err.turnstile.invalid") }, 400);

		author = await getOrCreateGhost(c.env.DB, ipHash, nameCheck.name);
		if (author.is_banned) return c.json({ error: t("err.banned") }, 403);
	} else {
		// Nothing free to reject on this path — the session cookie is already
		// verified — so the budget gates the user lookup too.
		const denied = await enforceWriteBudget();
		if (denied) return denied;

		const u = await c.env.DB
			.prepare(
				`SELECT id, provider, provider_id, name, email, avatar_url,
				        is_admin, is_banned, role, created_at
				 FROM users WHERE id = ?`,
			)
			.bind(session.user_id)
			.first<UserRow>();
		if (!u) return c.json({ error: t("err.session.expired") }, 401);
		author = rowToUser(u);
		if (author.is_banned) return c.json({ error: t("err.banned") }, 403);
	}

	// Make sure the post row exists so the FK on comments resolves.
	// Validate the supplied post_url scheme: only http/https. Anything else
	// (`javascript:`, `data:`, scheme-relative, garbage) is dropped to null
	// so the permalink redirect can't be used as an open-redirect gadget.
	let postUrl: string | null = null;
	if (body.post_url) {
		try {
			const u = new URL(body.post_url);
			if (u.protocol === "https:" || u.protocol === "http:") {
				postUrl = body.post_url;
			}
		} catch {
			// drop
		}
	}
	// Thread acceptance gate. The global comments_enabled switch was checked at
	// the top; this also enforces the per-post manual close and the lazy
	// auto-close rules (sunset date / age). It runs before the parent lookup and
	// insert, so it covers replies as well as top-level comments. The widget's
	// closed-state UI is cosmetic — this is the authoritative gate.
	//
	// Crucially it runs against the EXISTING stored post BEFORE upsertPost, so a
	// crafted request that fails the gate can't mutate the post row as a side
	// effect (e.g. persist a bogus published_at to poison the close-anchor and
	// then 403). A post with no row yet is open unless a global/sunset rule says
	// otherwise, so synthesize a default-open post for the resolver in that case.
	const existing = await getPost(c.env.DB, slug);
	const numbers = await loadNumbers(c.env);
	const threadState = resolveThreadOpen(
		existing ?? { closed: false, published_at: null, created_at: Date.now() },
		flags,
		numbers,
		Date.now(),
	);
	if (!threadState.open) {
		return c.json({ error: t("err.thread_closed") }, 403);
	}

	// Make sure the post row exists so the FK on comments resolves. published_at
	// is write-once in upsertPost (first-writer-wins), so this can establish a
	// fresh thread's anchor but can never overwrite an established one.
	await upsertPost(
		c.env.DB,
		slug,
		// post_title is caller-supplied at the same trust level as the comment
		// body but had no validation at all; see lib/post-title.ts for where it
		// fans out to (mail subjects, Atom, Slack/Discord).
		sanitizePostTitle(body.post_title),
		postUrl,
		parsePublishedAt(body.post_published),
	);

	// Parent must exist, live on the same post, and leave room under the
	// nesting cap. Without the depth check an unbounded reply chain is
	// insertable, which makes the slug's comment tree permanently
	// un-renderable — see MAX_REPLY_DEPTH in src/lib/tree.ts.
	let parent_id: string | null = null;
	let depth = 1;
	if (body.parent_id) {
		const parent = await getComment(c.env.DB, body.parent_id);
		if (!parent) return c.json({ error: t("err.parent.not_found") }, 400);
		if (parent.post_slug !== slug) {
			return c.json({ error: t("err.parent.different_post") }, 400);
		}
		parent_id = parent.id;
		depth = parent.depth + 1;
		if (depth > MAX_REPLY_DEPTH) {
			return c.json({ error: t("err.parent.too_deep") }, 400);
		}
	}

	const userAgent = c.req.header("user-agent") ?? null;
	const verdict = await evaluateSpam(
		c.env,
		flags,
		numbers,
		author,
		bodyCheck.body,
		postUrl,
		userAgent,
		body.form_ts,
	);
	if (verdict.reasons.length > 0) {
		log.info("spam.flagged", {
			reasons: verdict.reasons,
			post_slug: slug,
			provider: author.provider,
		});
	}

	const body_html = renderMarkdown(bodyCheck.body);
	const inserted = await insertComment(c.env.DB, {
		post_slug: slug,
		parent_id,
		user_id: author.id,
		body_md: bodyCheck.body,
		body_html,
		renderer_version: CURRENT_RENDERER_VERSION,
		status: verdict.status,
		ip_hash: ipHash,
		user_agent: userAgent,
		depth,
	});

	// Bust the cached first page. Older pages bypass cache, so there's
	// nothing else to invalidate. Pending comments don't appear in the
	// public tree but the cache key is the same; busting is still correct.
	await bustTreeCache(c.env, c.req.url, slug);

	// Persist whichever spam signals ran. Fire-and-forget so a slow D1
	// write never adds latency to the user-visible POST. Mirror the
	// fanout pattern: without executionCtx (non-HTTP entry points), the
	// runtime can cancel orphan promises after the response settles, so
	// we await synchronously rather than lose verdict rows.
	if (verdict.verdicts.length > 0) {
		const persist = persistVerdicts(c.env.DB, inserted.id, verdict.verdicts);
		if (c.executionCtx) c.executionCtx.waitUntil(persist);
		else await persist;
	}

	writeEvent(c.env.ANALYTICS, "comment.posted", {
		post_slug: slug,
		provider: author.provider,
		outcome: verdict.status,
	});
	fireWebhook(c.env, c.executionCtx, {
		event: "comment.posted",
		comment_id: inserted.id,
		post_slug: slug,
		user_id: author.id,
		ts: inserted.created_at,
	});

	// Pending comments don't notify subscribers — admins approve first.
	if (verdict.status === "approved") {
		const fanout = (async () => {
			const subs = await listActiveSubscriptionsForPost(c.env.DB, slug);
			const authorEmail = author.email?.toLowerCase() ?? null;
			for (const sub of subs) {
				if (authorEmail && sub.email === authorEmail) continue;
				await enqueueNotification(c.env.DB, sub.id, inserted.id);
			}
		})();
		// Always wait for the enqueue to finish. With executionCtx, it
		// runs after the response is sent; without (vanishingly rare —
		// only non-HTTP entry points lack one), we'd otherwise lose
		// notification rows on cold isolates because the runtime can
		// cancel orphan promises after the response settles. A few
		// extra ms beats silent data loss.
		if (c.executionCtx) c.executionCtx.waitUntil(fanout);
		else await fanout;
	}

	return c.json({ comment: serializeComment(inserted, author) }, 201);
});

/**
 * Builds a TreeAuthor map by loading every user referenced by `rows` in
 * one batch SELECT. Anonymous ghosts have no avatar_url, so the route
 * also fills in an inline identicon SVG so the widget doesn't need to
 * make a per-author request.
 */
/**
 * Chunk size for the author lookup. The `IN (…)` list scales with the number of
 * DISTINCT authors on a page, and D1 caps bound parameters per statement — one
 * busy thread of individually-named anonymous ghosts was enough to blow that
 * ceiling and 500 the whole comment list. Well under any plausible cap while
 * still keeping the round-trip count at one for an ordinary page.
 */
const AUTHOR_BATCH = 90;

const loadAuthors = async (
	db: D1Database,
	rows: TreeComment[],
): Promise<Map<string, TreeAuthor>> => {
	if (rows.length === 0) return new Map();
	const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
	const out = new Map<string, TreeAuthor>();
	for (let i = 0; i < userIds.length; i += AUTHOR_BATCH) {
		const batch = userIds.slice(i, i + AUTHOR_BATCH);
		const placeholders = batch.map(() => "?").join(",");
		const result = await db
			.prepare(
				`SELECT id, provider, provider_id, name, email, avatar_url,
				        is_admin, is_banned, role, created_at
				 FROM users WHERE id IN (${placeholders})`,
			)
			.bind(...batch)
			.all<UserRow>();
		for (const u of result.results ?? []) {
			const user = rowToUser(u);
			out.set(user.id, {
				id: user.id,
				name: user.name,
				provider: user.provider,
				avatar_url: user.avatar_url,
				avatar_svg: user.avatar_url ? null : identiconSvg(user.id),
			});
		}
	}
	return out;
};

type ListPayload = {
	post: Awaited<ReturnType<typeof getPost>>;
	threads: TreeNode[];
	next_cursor: string | null;
	/** Whether the widget should show the composer (vs. a closed notice). */
	accepting_comments: boolean;
	/** Why the thread is closed, for the closed-notice copy; null if open. */
	closed_reason: string | null;
};

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * `new`-sort cursor: just the ULID of the oldest top-level thread on the
 * current page. Threads are sorted DESC by created_at, so the next page is
 * `id < cursor`. The ULID (lexicographically-comparable, time-prefixed)
 * sidesteps the timestamp-collision edge case.
 */
const decodeCursor = (raw: string | null): string | null => {
	if (!raw) return null;
	return ULID_RE.test(raw) ? raw : null;
};

/**
 * `top`-sort cursor: `<score>:<ulid>` of the last thread on the current page.
 * `top` is ordered by (score DESC, id DESC) — a total order, since ULIDs are
 * unique — so the next page is everything ranked strictly after the cursor:
 * `score < cur.score || (score === cur.score && id < cur.id)`. Tie-breaking on
 * id (rather than created_at) keeps the cursor stable against ms collisions.
 *
 * Both cursors are re-encoded from the decoded value before use — as the page
 * cursor and as part of the cache key — so a cosmetically different spelling of
 * the same position can't mint a second cache entry.
 */
type TopCursor = { score: number; id: string };
const decodeTopCursor = (raw: string | null): TopCursor | null => {
	if (!raw) return null;
	const sep = raw.indexOf(":");
	if (sep <= 0) return null;
	const score = Number.parseInt(raw.slice(0, sep), 10);
	const id = raw.slice(sep + 1);
	if (!Number.isFinite(score) || !ULID_RE.test(id)) return null;
	return { score, id };
};

comments.get("/", async (c) => {
	const slug = (c.req.query("slug") ?? "").trim();
	if (!slug) return c.json({ error: t("err.post.required") }, 400);
	if (!SLUG_RE.test(slug)) return c.json({ error: t("err.post.invalid") }, 400);

	const sortParam = (c.req.query("sort") ?? "new").trim();
	const sort: "new" | "top" = sortParam === "top" ? "top" : "new";

	// Each sort has its own cursor encoding: `new` pages by ULID (id < cursor),
	// `top` pages by a composite score:id (see decodeTopCursor). A cursor from
	// the wrong sort decodes to null → treated as the first page.
	const beforeRaw = c.req.query("before") ?? null;
	const cursor = sort === "new" ? decodeCursor(beforeRaw) : null;
	const topCursor = sort === "top" ? decodeTopCursor(beforeRaw) : null;
	const session = await readSession(c);

	// Top-level threads per page, operator-tunable (DB > env > default 25),
	// clamped to [1,200] in the settings layer. The full numbers object is also
	// reused below to resolve the thread's accepting-comments state.
	const numbers = await loadNumbers(c.env);
	const pageSize = numbers.comments_per_page;

	// Cached at the edge (Cache API, not KV — see response-cache.ts) for
	// anonymous viewers only, keyed by sort AND page size so `top`/`new` and a
	// changed page size don't serve each other's slices. Signed-in viewers see
	// per-user my_vote / mine flags so they bypass the cache. Hit-rate stays
	// high on the public reader path, which dominates traffic.
	//
	// The cursor is part of the key rather than a reason to skip caching. It
	// used to be the latter, and because `decodeCursor` only checked ULID
	// *shape*, ANY well-formed ULID in `?before=` disabled the cache and sent
	// the request to D1 — an unauthenticated, cache-bypassing read amplifier in
	// front of an unbounded query. Only the canonically re-encoded cursor goes
	// into the key, so garbage normalizes to the first page instead of minting a
	// key of its own.
	const cursorKey = topCursor
		? `${topCursor.score}:${topCursor.id}`
		: (cursor ?? null);
	const cacheReq = treeCacheKey(c.req.url, slug, sort, pageSize, cursorKey);
	const cacheable = !session;
	if (cacheable) {
		const hit = await matchCache(cacheReq);
		// Re-emit the body WITHOUT the edge copy's public Cache-Control: the
		// widget fetches this credentialed, and a browser-cached anonymous page
		// must never be reused for the same user after they sign in.
		if (hit) return jsonResponse(await hit.text());
	}

	const post = await getPost(c.env.DB, slug);

	// Pagination happens in SQL. One query picks this page's top-level threads
	// in the sort's own order; a second pulls just those threads' subtrees. The
	// old shape loaded EVERY comment on the slug — no LIMIT, full markdown
	// source and ip_hash included — built the whole tree, then sliced 25 threads
	// off the top in memory.
	//
	// A signed-in viewer additionally sees their own `pending` comments (so a
	// moderated post visibly landed); that predicate is pushed into both queries
	// rather than merged from a third, and those responses are uncached.
	const viewerId = session?.user_id ?? null;
	const refs = await listThreadRefsForPost(c.env.DB, slug, {
		sort,
		// One extra row, purely to learn whether a further page exists. Its
		// subtree is deliberately NOT fetched.
		limit: pageSize + 1,
		cursor: topCursor ?? (cursor ? { id: cursor } : null),
		viewer_id: viewerId,
	});
	const pageRefs = refs.slice(0, pageSize);
	const more = refs.length > pageSize;

	const { rows, truncated } = await listCommentsForThreads(
		c.env.DB,
		pageRefs.map((r) => r.id),
		viewerId,
	);
	if (truncated) {
		log.warn("comments.page_truncated", {
			post_slug: slug,
			sort,
			threads: pageRefs.length,
			limit: TREE_ROW_LIMIT,
		});
	}
	const authors = await loadAuthors(c.env.DB, rows);

	const reactionRows = await listReactionsForPost(c.env.DB, slug);
	const mineSet = session
		? await listUserReactionsOnPost(c.env.DB, slug, session.user_id)
		: new Set<string>();
	const reactionsById = new Map<string, ReactionCount[]>();
	for (const r of reactionRows) {
		const list = reactionsById.get(r.comment_id) ?? [];
		list.push({
			kind: r.kind,
			count: r.count,
			mine: mineSet.has(`${r.comment_id}|${r.kind}`),
		});
		reactionsById.set(r.comment_id, list);
	}

	const myVotes = session
		? await getUserVotesOnPost(c.env.DB, slug, session.user_id)
		: new Map<string, -1 | 1>();

	// When the operator opts in, keep every deleted comment as a placeholder
	// (leaf deletions included) rather than pruning them. A toggle change is
	// reflected for anonymous viewers within the tree-cache TTL.
	const flags = await loadFlags(c.env);
	const keepAllDeleted = flags.show_deleted_placeholders;

	const { threads: allThreads } = buildTree(rows, authors, reactionsById, myVotes, {
		keepAllDeleted,
	});

	// SQL already ordered and sliced the threads; restore that order over the
	// builder's output, which always comes back created_at ASC. Replies stay
	// created_at ASC either way so threaded conversation reads top-down.
	const rank = new Map(pageRefs.map((r, i) => [r.id, i]));
	const page = allThreads.sort(
		(a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
	);

	// Cursor comes from the last thread SQL *selected*, not the last one
	// rendered. They differ when the builder pruned a tail thread (a deleted
	// comment whose whole subtree is also deleted), and using the rendered one
	// would re-scan the pruned thread on every subsequent page.
	const lastRef = pageRefs[pageRefs.length - 1];
	const next_cursor = more && lastRef
		? sort === "top"
			? `${lastRef.score}:${lastRef.id}`
			: lastRef.id
		: null;

	// Whether new comments are accepted, so the widget can show the composer or a
	// closed notice. A post with no row yet (no comments posted) is open unless a
	// global/sunset rule says otherwise, so synthesize a default-open post for
	// the resolver in that case. Anonymous viewers may see this lag a sunset/age
	// flip by up to the tree-cache TTL — acceptable (the POST gate is exact).
	const threadState = resolveThreadOpen(
		post ?? { closed: false, published_at: null, created_at: Date.now() },
		flags,
		numbers,
		Date.now(),
	);
	const payload: ListPayload = {
		post,
		threads: page,
		next_cursor,
		accepting_comments: threadState.open,
		closed_reason: threadState.reason ?? null,
	};

	// Write-through to the edge cache; the put runs after the response when an
	// ExecutionContext is available (real requests), else inline.
	//
	// An empty cursor page is deliberately NOT stored. A cursor is unvalidated
	// against the data — any well-formed ULID decodes fine and simply matches no
	// thread — so caching those would let one client mint unlimited distinct
	// cache entries from a random-ULID loop. Real pages are bounded by the
	// thread count.
	if (cacheable && (cursorKey === null || page.length > 0)) {
		return cacheJson(
			cacheReq,
			JSON.stringify(payload),
			TREE_CACHE_TTL,
			tryWaitUntil(c),
		);
	}

	return c.json(payload);
});

/**
 * Return the raw markdown source of a comment so the widget's edit form can
 * prefill with what the author originally typed. The tree endpoint only ships
 * `body_html`; round-tripping an edit needs `body_md`. Gated identically to the
 * PATCH below (author-only, within the edit window) since it's the same
 * authorization surface — only the author, only while still editable.
 */
comments.get("/:id/source", async (c) => {
	const id = c.req.param("id");

	// Session before the lookup, matching PATCH. The other order answered 404
	// for an unknown id and 403 for a real one, so an unauthenticated caller
	// could probe which comment ids exist. A signed-in caller can still tell
	// "someone else's comment" (403) from "no such comment" (404), which is the
	// same shape PATCH has and a far weaker signal: it costs a session and a
	// guess at a 128-bit ULID.
	const session = await readSession(c);
	const sessionUserId = session?.user_id;
	if (!sessionUserId) return c.json({ error: t("err.edit.not_author") }, 403);

	const existing = await getComment(c.env.DB, id);
	if (!existing) return c.json({ error: t("err.not_found") }, 404);
	if (sessionUserId !== existing.user_id) {
		return c.json({ error: t("err.edit.not_author") }, 403);
	}

	// Only what PATCH would accept an edit to. Without this the form could
	// prefill from a comment the author can no longer edit — and, for `spam`,
	// the 200 disclosed the quarantine that PATCH deliberately hides behind 404.
	if (existing.status !== "approved" && existing.status !== "pending") {
		return c.json({ error: t("err.not_found") }, 404);
	}

	const numbers = await loadNumbers(c.env);
	if (Date.now() - existing.created_at > editWindowMs(numbers)) {
		return c.json({ error: t("err.edit.window_expired") }, 403);
	}

	return c.json({ body_md: existing.body_md });
});

comments.patch("/:id", async (c) => {
	const id = c.req.param("id");

	// Session and rate limit before the comment lookup, so an unauthenticated
	// or over-budget caller can't spend a D1 read per request. (This also stops
	// the handler answering 404-vs-403 to callers who aren't signed in at all,
	// which leaked whether a given comment id exists.)
	const session = await readSession(c);
	const sessionUserId = session?.user_id;
	if (!sessionUserId) return c.json({ error: t("err.edit.not_author") }, 403);

	const rl = await checkRateLimit(c.req.url, `user:${sessionUserId}`, {
		scope: "comment-mutate",
		config: MUTATE_COMMENT_LIMITS,
	});
	if (!rl.ok) return c.json({ error: t("err.ratelimit") }, 429);

	// Editing was the one write path a banned user kept: POST checks is_banned,
	// this didn't, so anything already inside the edit window could be rewritten
	// into whatever they liked. The row doubles as the author for the spam pass
	// and the response below — same user, since only the author may edit.
	const author = await requireActiveUser(c.env.DB, sessionUserId);
	if (!author) return c.json({ error: t("err.banned") }, 403);

	const existing = await getComment(c.env.DB, id);
	if (!existing) return c.json({ error: t("err.not_found") }, 404);

	if (sessionUserId !== existing.user_id) {
		return c.json({ error: t("err.edit.not_author") }, 403);
	}

	// Only a live comment is editable. `deleted` and `spam` answer 404 like a
	// missing row rather than confirming what a moderator did with it.
	if (existing.status !== "approved" && existing.status !== "pending") {
		return c.json({ error: t("err.not_found") }, 404);
	}

	const numbers = await loadNumbers(c.env);
	if (Date.now() - existing.created_at > editWindowMs(numbers)) {
		return c.json({ error: t("err.edit.window_expired") }, 403);
	}

	const body = await c.req.json<{ body?: string }>().catch(() => null);
	if (!body) return c.json({ error: t("err.internal") }, 400);
	const bodyCheck = validateBody(body.body ?? "");
	if (!bodyCheck.ok) {
		const args = bodyCheck.max != null ? { max: bodyCheck.max } : undefined;
		return c.json({ error: t(bodyCheck.key, args) }, 400);
	}

	// Re-run the spam pass on the new text. Without this, "post something benign,
	// get approved, then rewrite it inside the edit window" published arbitrary
	// content straight past moderation — bustTreeCache below makes it live
	// immediately.
	const flags = await loadFlags(c.env);
	const post = await getPost(c.env.DB, existing.post_slug);
	const verdict = await evaluateSpam(
		c.env,
		flags,
		numbers,
		author,
		bodyCheck.body,
		post?.url ?? null,
		c.req.header("user-agent") ?? null,
		undefined,
		{ skipFormTs: true },
	);
	// An edit can send a comment back to the queue but never pull one out of it:
	// approving is a moderator's call.
	const nextStatus: CommentStatus =
		verdict.status === "pending" || existing.status === "pending"
			? "pending"
			: "approved";
	if (verdict.reasons.length > 0) {
		log.info("spam.flagged", {
			reasons: verdict.reasons,
			post_slug: existing.post_slug,
			provider: author.provider,
			on: "edit",
		});
	}

	const body_html = renderMarkdown(bodyCheck.body);
	await updateCommentBody(
		c.env.DB,
		id,
		bodyCheck.body,
		body_html,
		CURRENT_RENDERER_VERSION,
		nextStatus === existing.status ? undefined : nextStatus,
	);
	await bustTreeCache(c.env, c.req.url, existing.post_slug);

	// Same fire-and-forget shape as POST, so the moderator sees why the edit was
	// held.
	if (verdict.verdicts.length > 0) {
		const persist = persistVerdicts(c.env.DB, id, verdict.verdicts);
		if (c.executionCtx) c.executionCtx.waitUntil(persist);
		else await persist;
	}

	writeEvent(c.env.ANALYTICS, "comment.edited", {
		post_slug: existing.post_slug,
		outcome: nextStatus,
	});
	fireWebhook(c.env, c.executionCtx, {
		event: "comment.edited",
		comment_id: id,
		post_slug: existing.post_slug,
		user_id: existing.user_id,
		ts: Date.now(),
	});
	const updated = await getComment(c.env.DB, id);
	if (!updated) return c.json({ error: t("err.internal") }, 500);
	return c.json({ comment: serializeComment(updated, author) });
});

comments.delete("/:id", async (c) => {
	const id = c.req.param("id");

	// Same ordering as PATCH above: session, then budget, then the D1 read.
	const session = await readSession(c);
	const sessionUserId = session?.user_id;
	if (!sessionUserId) {
		return c.json({ error: t("err.delete.not_author") }, 403);
	}

	const rl = await checkRateLimit(c.req.url, `user:${sessionUserId}`, {
		scope: "comment-mutate",
		config: MUTATE_COMMENT_LIMITS,
	});
	if (!rl.ok) return c.json({ error: t("err.ratelimit") }, 429);

	// Also the caller row for the admin-override branch below, which used to run
	// its own `SELECT is_admin` — a second D1 read that saw neither `is_banned`
	// nor `role`. `is_admin` is a legacy mirror of `role` (migration 0005 says
	// the column is going away), so authorize on `role` and keep the two in one
	// place.
	const caller = await requireActiveUser(c.env.DB, sessionUserId);
	if (!caller) return c.json({ error: t("err.banned") }, 403);

	const existing = await getComment(c.env.DB, id);
	if (!existing) return c.json({ error: t("err.not_found") }, 404);

	if (sessionUserId !== existing.user_id) {
		// Admin override: allow admins to delete any comment via the public
		// API, mirroring the moderation queue's delete action. Editing
		// other users' comments is intentionally still author-only. Mods are
		// deliberately not included — this stays exactly as narrow as the
		// is_admin check it replaces.
		if (caller.role !== "admin") {
			return c.json({ error: t("err.delete.not_author") }, 403);
		}
	}

	await softDeleteComment(c.env.DB, id);
	await bustTreeCache(c.env, c.req.url, existing.post_slug);
	writeEvent(c.env.ANALYTICS, "comment.deleted", { post_slug: existing.post_slug });
	fireWebhook(c.env, c.executionCtx, {
		event: "comment.deleted",
		comment_id: id,
		post_slug: existing.post_slug,
		user_id: existing.user_id,
		ts: Date.now(),
	});
	return c.json({ ok: true });
});

export { comments };
