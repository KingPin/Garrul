/**
 * /api/v1/comments — anonymous comment CRUD.
 *
 * M2 scope: anonymous-only path. OAuth (M5) will add a branch that skips
 * Turnstile + uses the session user_id instead of a ghost user.
 *
 * Routes:
 *   POST   /api/v1/comments              create
 *   GET    /api/v1/comments?slug=<slug>  list (flat; tree assembled M4)
 *   PATCH  /api/v1/comments/:id          edit (within EDIT_WINDOW_MINUTES)
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
	listCommentsForPost,
	listReactionsForPost,
	listUserReactionsOnPost,
	softDeleteComment,
	updateCommentBody,
	upsertPost,
	type Comment,
	type SpamVerdictSource,
	type SpamVerdictValue,
	type User,
} from "../db/queries";
import { identiconSvg } from "../lib/identicon";
import { clientIp, hashIp } from "../lib/ip-hash";
import { CURRENT_RENDERER_VERSION, renderMarkdown, validateBody } from "../lib/markdown";
import { checkRateLimit } from "../lib/ratelimit";
import { readSession } from "../lib/session";
import { verifyTurnstile } from "../lib/turnstile";
import { writeEvent } from "../lib/analytics";
import { fireWebhook } from "../lib/webhook";
import { loadFlags, loadNumbers } from "../lib/settings";
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

type CreateBody = {
	slug?: string;
	parent_id?: string | null;
	name?: string;
	body?: string;
	turnstile_token?: string;
	post_title?: string | null;
	post_url?: string | null;
	form_ts?: string;
	[HONEYPOT_FIELD]?: string;
};

const editWindowMs = (env: Bindings): number => {
	const minutes = Number.parseInt(env.EDIT_WINDOW_MINUTES, 10);
	return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 5 * 60_000;
};

const validName = (raw: string | undefined): { ok: true; name: string } | { ok: false; key: "err.name.required" | "err.name.too_long"; max?: number } => {
	const name = (raw ?? "").trim();
	if (!name) return { ok: false, key: "err.name.required" };
	if (name.length > MAX_NAME) return { ok: false, key: "err.name.too_long", max: MAX_NAME };
	return { ok: true, name };
};

const serializeComment = (c: Comment, author: User) => {
	const visible = c.status === "deleted";
	return {
		id: c.id,
		post_slug: c.post_slug,
		parent_id: c.parent_id,
		body_html: visible ? "" : c.body_html,
		status: c.status,
		edited_at: c.edited_at,
		deleted_at: c.deleted_at,
		created_at: c.created_at,
		author: {
			id: author.id,
			name: author.name,
			provider: author.provider,
			is_admin: author.is_admin,
			avatar_svg: author.avatar_url ? null : identiconSvg(author.id),
			avatar_url: author.avatar_url,
		},
	};
};

/**
 * Mint a signed HMAC timestamp so the widget can prove how long the form was
 * displayed before submission. Verified server-side when both
 * `SPAM_HONEYPOT_MIN_MS` and `SPAM_FORM_TS_SECRET` are configured.
 *
 * 404s when either is missing — the widget always asks for a token but
 * tolerates a missing one (the existing field-honeypot still applies),
 * and we don't want to expose an endpoint that signs tokens nothing
 * will ever check.
 */
comments.get("/form-token", async (c) => {
	const secret = c.env.SPAM_FORM_TS_SECRET;
	const minMs = Number.parseInt(c.env.SPAM_HONEYPOT_MIN_MS ?? "", 10);
	if (!secret || !Number.isFinite(minMs) || minMs <= 0) {
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
 * decide whether it goes in as `approved` or `pending`. Each signal is
 * gated by its own env var. Admins skip the check entirely. Heuristics
 * run first and short-circuit the (potentially paid) classifier call.
 *
 * Per-source verdicts are surfaced alongside the routing decision so the
 * caller can persist them to spam_verdicts once the comment id is known
 * (see persistVerdicts).
 */
const evaluateSpam = async (
	env: Bindings,
	author: User,
	bodyMd: string,
	postUrl: string | null,
	userAgent: string | null,
	formTs: string | undefined,
): Promise<SpamEvaluation> => {
	if (author.is_admin) return { status: "approved", reasons: [], verdicts: [] };
	const reasons: string[] = [];
	const verdicts: PendingVerdict[] = [];
	const heuristicsRaw: Record<string, unknown> = {};

	const minMs = Number.parseInt(env.SPAM_HONEYPOT_MIN_MS ?? "", 10);
	if (Number.isFinite(minMs) && minMs > 0 && env.SPAM_FORM_TS_SECRET) {
		const v = await verifyFormTimestamp(
			formTs,
			env.SPAM_FORM_TS_SECRET,
			Date.now(),
			minMs,
		);
		heuristicsRaw.form_ts = { flag: v.flag, reason: v.reason ?? null };
		if (v.flag) reasons.push(v.reason ?? "form_ts");
	}

	const linkThreshold = Number.parseInt(env.SPAM_LINK_THRESHOLD ?? "", 10);
	if (Number.isFinite(linkThreshold) && linkThreshold >= 0) {
		const n = countLinks(bodyMd);
		heuristicsRaw.link_count = { count: n, threshold: linkThreshold };
		if (n > linkThreshold) reasons.push(`link_count:${n}`);
	}

	// Compute is_first_comment if either the moderate-on-first heuristic
	// or the classifier is enabled — classifiers use it as a feature even
	// when the operator hasn't asked us to auto-moderate on it.
	const moderateFirst = env.SPAM_FIRST_COMMENT_MODERATE === "true";
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

	// Anonymous path: name + Turnstile + rate-limit required.
	let author: User;
	const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_HASH_SECRET);

	if (!session) {
		const nameCheck = validName(body.name);
		if (!nameCheck.ok) {
			const args = nameCheck.max != null ? { max: nameCheck.max } : undefined;
			return c.json({ error: t(nameCheck.key, args) }, 400);
		}

		if (!body.turnstile_token) {
			return c.json({ error: t("err.turnstile.required") }, 400);
		}
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

		const rl = await checkRateLimit(c.env, ipHash);
		if (!rl.ok) {
			writeEvent(c.env.ANALYTICS, "ratelimit.hit", {
				outcome: rl.reason ?? null,
				post_slug: slug,
			});
			return c.json({ error: t("err.ratelimit") }, 429);
		}

		author = await getOrCreateGhost(c.env.DB, ipHash, nameCheck.name);
		if (author.is_banned) return c.json({ error: t("err.banned") }, 403);
	} else {
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
	await upsertPost(c.env.DB, slug, body.post_title ?? null, postUrl);

	// Parent must exist and live on the same post.
	let parent_id: string | null = null;
	if (body.parent_id) {
		const parent = await getComment(c.env.DB, body.parent_id);
		if (!parent) return c.json({ error: t("err.parent.not_found") }, 400);
		if (parent.post_slug !== slug) {
			return c.json({ error: t("err.parent.different_post") }, 400);
		}
		parent_id = parent.id;
	}

	const userAgent = c.req.header("user-agent") ?? null;
	const verdict = await evaluateSpam(
		c.env,
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
const loadAuthors = async (
	db: D1Database,
	rows: Comment[],
): Promise<Map<string, TreeAuthor>> => {
	if (rows.length === 0) return new Map();
	const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
	const placeholders = userIds.map(() => "?").join(",");
	const result = await db
		.prepare(
			`SELECT id, provider, provider_id, name, email, avatar_url,
			        is_admin, is_banned, role, created_at
			 FROM users WHERE id IN (${placeholders})`,
		)
		.bind(...userIds)
		.all<UserRow>();
	const out = new Map<string, TreeAuthor>();
	for (const u of result.results ?? []) {
		const user = rowToUser(u);
		out.set(user.id, {
			id: user.id,
			name: user.name,
			provider: user.provider,
			is_admin: user.is_admin,
			avatar_url: user.avatar_url,
			avatar_svg: user.avatar_url ? null : identiconSvg(user.id),
		});
	}
	return out;
};

type ListPayload = {
	post: Awaited<ReturnType<typeof getPost>>;
	threads: TreeNode[];
	next_cursor: string | null;
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

/** Net score (up − down) of a thread, the `top`-sort key. */
const threadScore = (t: TreeNode): number => t.score_up - t.score_down;

/**
 * `top`-sort cursor: `<score>:<ulid>` of the last thread on the current page.
 * `top` is ordered by (score DESC, id DESC) — a total order, since ULIDs are
 * unique — so the next page is everything ranked strictly after the cursor:
 * `score < cur.score || (score === cur.score && id < cur.id)`. Tie-breaking on
 * id (rather than created_at) keeps the cursor stable against ms collisions.
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
const encodeTopCursor = (t: TreeNode): string => `${threadScore(t)}:${t.id}`;

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
	// clamped to [1,200] in the settings layer.
	const pageSize = (await loadNumbers(c.env)).comments_per_page;

	// Fast path: first page is cached at the edge (Cache API, not KV — see
	// response-cache.ts) for anonymous viewers only, keyed by sort AND page
	// size so `top`/`new` and a changed page size don't serve each other's
	// slices. Signed-in viewers see per-user my_vote / mine flags so they
	// bypass the cache. Hit-rate stays high on the public reader path, which
	// dominates traffic.
	const cacheReq = treeCacheKey(c.req.url, slug, sort, pageSize);
	const hasCursor = cursor !== null || topCursor !== null;
	const cacheable = !hasCursor && !session;
	if (cacheable) {
		const hit = await matchCache(cacheReq);
		// Re-emit the body WITHOUT the edge copy's public Cache-Control: the
		// widget fetches this credentialed, and a browser-cached anonymous page
		// must never be reused for the same user after they sign in.
		if (hit) return jsonResponse(await hit.text());
	}

	const post = await getPost(c.env.DB, slug);
	const rows = await listCommentsForPost(c.env.DB, slug);
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

	const { threads: allThreads } = buildTree(rows, authors, reactionsById, myVotes);

	if (sort === "top") {
		// Top-level only — replies stay in created_at ASC so threaded
		// conversation reads top-down. Order by (score DESC, id DESC): a total
		// order over unique ULIDs, which the composite score:id cursor pages
		// through. id-desc also floats a fresher same-score comment above an
		// older one (ULIDs are time-monotonic).
		allThreads.sort((a, b) => {
			const d = threadScore(b) - threadScore(a);
			if (d !== 0) return d;
			return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
		});
	} else {
		// Newest-first top-level ordering. The tree builder returns ASC so
		// we reverse here; widget pages with ?before=<oldest_id_on_page>.
		allThreads.reverse();
	}

	// Apply the cursor: drop everything up to and including it, in the sort's
	// own order. `new` → id < cursor; `top` → ranked strictly after (score,id).
	let startIdx = 0;
	if (cursor) {
		const i = allThreads.findIndex((t) => t.id < cursor);
		startIdx = i < 0 ? allThreads.length : i;
	} else if (topCursor) {
		const i = allThreads.findIndex(
			(t) =>
				threadScore(t) < topCursor.score ||
				(threadScore(t) === topCursor.score && t.id < topCursor.id),
		);
		startIdx = i < 0 ? allThreads.length : i;
	}
	const page = allThreads.slice(startIdx, startIdx + pageSize);
	const more = allThreads.length > startIdx + pageSize;
	const last = page[page.length - 1];
	const next_cursor = more && last
		? sort === "top"
			? encodeTopCursor(last)
			: last.id
		: null;

	const payload: ListPayload = { post, threads: page, next_cursor };

	if (cacheable) {
		// Write-through to the edge cache; the put runs after the response when
		// an ExecutionContext is available (real requests), else inline.
		return cacheJson(
			cacheReq,
			JSON.stringify(payload),
			TREE_CACHE_TTL,
			tryWaitUntil(c),
		);
	}

	return c.json(payload);
});

comments.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const existing = await getComment(c.env.DB, id);
	if (!existing) return c.json({ error: t("err.not_found") }, 404);

	const session = await readSession(c);
	const sessionUserId = session?.user_id;
	if (!sessionUserId || sessionUserId !== existing.user_id) {
		return c.json({ error: t("err.edit.not_author") }, 403);
	}

	if (Date.now() - existing.created_at > editWindowMs(c.env)) {
		return c.json({ error: t("err.edit.window_expired") }, 403);
	}

	const body = await c.req.json<{ body?: string }>().catch(() => null);
	if (!body) return c.json({ error: t("err.internal") }, 400);
	const bodyCheck = validateBody(body.body ?? "");
	if (!bodyCheck.ok) {
		const args = bodyCheck.max != null ? { max: bodyCheck.max } : undefined;
		return c.json({ error: t(bodyCheck.key, args) }, 400);
	}

	const body_html = renderMarkdown(bodyCheck.body);
	await updateCommentBody(
		c.env.DB,
		id,
		bodyCheck.body,
		body_html,
		CURRENT_RENDERER_VERSION,
	);
	await bustTreeCache(c.env, c.req.url, existing.post_slug);
	writeEvent(c.env.ANALYTICS, "comment.edited", { post_slug: existing.post_slug });
	fireWebhook(c.env, c.executionCtx, {
		event: "comment.edited",
		comment_id: id,
		post_slug: existing.post_slug,
		user_id: existing.user_id,
		ts: Date.now(),
	});
	const updated = await getComment(c.env.DB, id);
	if (!updated) return c.json({ error: t("err.internal") }, 500);
	const authorRow = await c.env.DB
		.prepare(
			`SELECT id, provider, provider_id, name, email, avatar_url,
			        is_admin, is_banned, role, created_at
			 FROM users WHERE id = ?`,
		)
		.bind(updated.user_id)
		.first<UserRow>();
	if (!authorRow) return c.json({ error: t("err.internal") }, 500);
	return c.json({ comment: serializeComment(updated, rowToUser(authorRow)) });
});

comments.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const existing = await getComment(c.env.DB, id);
	if (!existing) return c.json({ error: t("err.not_found") }, 404);

	const session = await readSession(c);
	const sessionUserId = session?.user_id;
	if (!sessionUserId) {
		return c.json({ error: t("err.delete.not_author") }, 403);
	}
	if (sessionUserId !== existing.user_id) {
		// Admin override: allow admins to delete any comment via the public
		// API, mirroring the moderation queue's delete action. Editing
		// other users' comments is intentionally still author-only.
		const caller = await c.env.DB
			.prepare(`SELECT is_admin FROM users WHERE id = ?`)
			.bind(sessionUserId)
			.first<{ is_admin: number }>();
		if (!caller || caller.is_admin !== 1) {
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
