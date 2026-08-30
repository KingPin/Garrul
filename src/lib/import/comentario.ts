/**
 * Comentario v3 + legacy Commento v1 export adapter (#106).
 *
 * Both formats are gzipped JSON with a `version` field at the top level, and
 * they are the same lineage: Comentario began as a Commento 1.8 fork and its
 * own importer still reads v1. So one adapter sniffs the version and parses
 * both, exactly as upstream's `comentarioImport` does.
 *
 *   { "version": 1, comments[], commenters[] }              → Commento
 *   { "version": 3, pages[], comments[], commenters[] }     → Comentario
 *
 * Anything else is refused by version number rather than guessed at. Upstream
 * does the same, and a v2 export does not exist in the wild — v2 was the fork's
 * transitional line and never had its own export format.
 *
 * ## The two formats disagree about where a page lives
 *
 * v3 has a real `pages[]` array: a page is a row with its own UUID, a `path`,
 * an optional `title` and an `isReadonly` flag. v1 has no page records at all —
 * a page exists only as the `host` + `path` pair repeated on every comment, so
 * threads are reconstructed by grouping, the way the Remark42 adapter groups on
 * `locator.url`.
 *
 * v1 also files the path under **either** key. Upstream's comment on this is
 * the whole explanation: *"Commento filed the path under `url`, whereas
 * Comentario used `path`"* — so v1 comments carry both fields and the reader
 * takes `path` when set and `url` when not, then forces a single leading
 * slash. Getting this wrong does not fail loudly; it silently slugs every
 * thread wrong.
 *
 * ## Neither format exports a hostname you can rely on
 *
 * A v3 export has no domain record. Pages carry a `domainId` UUID and nothing
 * else, so the only place a real host ever appears is `comment.url`, which is
 * a full permalink of the shape `https://host/path#comentario-<uuid>`. The
 * page link is therefore recovered from the first comment on that page with a
 * parseable url, minus the fragment; a page with no comments has no link and no
 * comments to hang off one, so it is not emitted at all.
 *
 * v1 is the easier half: `host` is on every comment, so the link is
 * `https://<host><path>`. The scheme is assumed because v1 does not record
 * one — `safePostUrl` in the core still gets the last word on what may reach
 * `posts.url`.
 *
 * ## One export is one domain, and that is not enforced by the format
 *
 * A v3 export can legitimately contain pages from several domains, and v1
 * comments can carry several `host` values. Garrul slugs are single-site, so
 * flattening them collides `/about` from two different sites onto one page
 * without saying so. The parse therefore **throws** when it sees more than one,
 * and `comentarioAdapter({ domain })` narrows to a single domain — the v3
 * `domainId` UUID, or the v1 host — for operators who cannot re-export.
 *
 * ## Moderation state
 *
 * v3 carries three independent booleans and v1 a state string. Upstream's
 * mapping is authoritative and is reproduced here:
 *
 *   v1  state === "approved"     → approved
 *       state === "unapproved"   → pending
 *       anything else            → spam      (Commento's "flagged")
 *   v3  isDeleted                → deleted
 *       isPending                → pending
 *       isApproved               → approved
 *       neither                  → spam      (moderator-rejected)
 *
 * "Rejected" has no separate Garrul status and `spam` is the one that
 * `include_spam` gates, so a rejected comment stays out by default. It is not a
 * claim that the comment was spam — it is a claim that the operator already
 * refused it once.
 *
 * ## The v1 deletion trap
 *
 * A Commento export's SQL never selects `html` or `deleted`, so `html` is
 * always `""` and **`deleted` is always `false`** — including for comments that
 * really were deleted. Deletion elsewhere in Commento rewrites `markdown` to
 * the literal `[deleted]`, and that sentinel is the only surviving signal.
 *
 * Trusting `deleted` therefore imports tombstones as live comments whose body
 * reads `[deleted]`. Upstream reached the same conclusion and treats all three
 * as deletion:
 *
 *     del := comment.Deleted || comment.Markdown == "" || comment.Markdown == "[deleted]"
 *
 * That is adopted verbatim. `isModerator` on a v1 commenter is unselected for
 * the same reason and is always false, so it is not read at all rather than
 * read and disbelieved.
 *
 * ## Identity
 *
 * Registered authors key on the source's own id — `commenterHex` (a sha256 hex)
 * in v1, the commenter UUID in v3. Anonymous ones deliberately do not, and fall
 * back to the core's name+email seed:
 *
 *   v1  every anonymous comment shares one sentinel — either 64 zeros or the
 *       literal string `anonymous`, which upstream calls *"a special ugly case
 *       for the anonymous commenter in Commento"*. Keying on it would collapse
 *       every anonymous commenter in the forum onto a single ghost. A comment
 *       with no `commenterHex` at all is read the same way: `commenters[]`
 *       rejects an empty one, so there is no author it could ever name.
 *   v3  the sentinel is the zero UUID, and the unregistered author's real name
 *       lives on the comment as `authorName`. Keying on the sentinel would
 *       throw that name away.
 *
 * Per the core's contract this choice is permanent for `import_source`
 * `comentario`: the seed feeds an HMAC, so changing it re-ghosts every
 * commenter this adapter has ever imported.
 *
 * ## Deliberately discarded
 *
 * `score`, `direction`, `isSticky`, `countViews`, `countComments`,
 * `colourIndex`, `hasAvatar`, `avatarUrl`, `websiteUrl`, `provider`,
 * `federatedIdP`, and the `userModerated` / `userDeleted` / `userEdited`
 * attribution ids — Garrul has no column for any of them. Votes and scores are
 * out of scope for every importer per #104.
 *
 * `authorIP` and `authorCountry` are dropped as a rule rather than an
 * oversight. Garrul neither stores nor logs a raw or derived IP, and a v3
 * export carries the raw one. Nothing in this file reads either field, and a
 * parse error names a record's id or index, never its contents.
 */
import {
	type ImportAdapter,
	type ImportOptions,
	type ImportPlan,
	MAX_IMPORT_BYTES,
	type SourceAuthor,
	type SourceComment,
	type SourceExport,
	type SourceStatus,
	type SourceThread,
	listIdentifiers,
	requireKnownIdentifier,
	runImport,
} from "./core";

/** Export format versions this parser has been read against. */
const SUPPORTED_VERSIONS = new Set([1, 3]);

/**
 * Go's zero `time.Time`, which is what both formats emit for an unset
 * timestamp. It is a valid date, so `Date.parse` accepts it happily and every
 * comment comes back looking deleted and edited in the year 1.
 */
const GO_ZERO_TIME_YEAR = 1;

/** Commento's two spellings of "nobody". */
const V1_ANONYMOUS_HEXES = new Set([
	"0".repeat(64),
	"anonymous",
]);

/** Comentario's zero UUID stands in for the unregistered author. */
const V3_ANONYMOUS_ID = "00000000-0000-0000-0000-000000000000";

/** Commento's root sentinel is a word, not an empty string. */
const V1_ROOT_PARENT = "root";

export type ComentarioV1Comment = {
	commentHex: string;
	commenterHex: string;
	creationDate: string;
	/** Always false in a real export — see the deletion trap in the header. */
	deleted: boolean;
	host: string;
	markdown: string;
	/** `"root"` at the top level, never empty and never absent. */
	parentHex: string;
	/** Either of these carries the page path; `path` wins when both are set. */
	path: string;
	url: string;
	state: string;
};

export type ComentarioV1Commenter = {
	commenterHex: string;
	email: string;
	name: string;
};

export type ComentarioV3Page = {
	id: string;
	domainId: string;
	path: string;
	/** Absent when the operator never set one and none was scraped. */
	title?: string | undefined;
	isReadonly: boolean;
	createdTime: string;
};

export type ComentarioV3Comment = {
	id: string;
	/** Absent at root — go-swagger omits the empty uuid. */
	parentId?: string | undefined;
	pageId: string;
	markdown: string;
	isApproved: boolean;
	isPending: boolean;
	isDeleted: boolean;
	createdTime: string;
	editedTime: string;
	userCreated: string;
	/** The unregistered author's name; absent for a registered one. */
	authorName?: string | undefined;
	/** Full permalink. The only place a v3 export names a host. */
	url: string;
};

export type ComentarioV3Commenter = {
	id: string;
	email: string;
	name: string;
};

export type ComentarioExport =
	| {
			version: 1;
			comments: ComentarioV1Comment[];
			commenters: ComentarioV1Commenter[];
	  }
	| {
			version: 3;
			pages: ComentarioV3Page[];
			comments: ComentarioV3Comment[];
			commenters: ComentarioV3Commenter[];
	  };

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A missing array and an empty one mean the same thing: an empty export. */
const arr = (v: unknown): Record<string, unknown>[] =>
	Array.isArray(v) ? v.filter(isObject) : [];

/**
 * A timestamp in epoch milliseconds, or null when the source did not set one.
 *
 * Go's zero time is the sentinel both formats use for "never happened", and it
 * parses cleanly, so it has to be rejected by value rather than by parse
 * failure.
 */
const parseTime = (s: string): number | null => {
	if (!s) return null;
	const t = Date.parse(s);
	if (!Number.isFinite(t)) return null;
	if (new Date(t).getUTCFullYear() <= GO_ZERO_TIME_YEAR) return null;
	return t;
};

/** Same, but for a field that must produce something. */
const parseTimeOr = (s: string, fallback: number): number =>
	parseTime(s) ?? fallback;

/**
 * The page path a v1 comment belongs to.
 *
 * `path` when it is set, `url` when it is not, then exactly one leading slash —
 * upstream's `comentarioImportV1` does the same three steps in the same order.
 */
const v1PagePath = (c: ComentarioV1Comment): string =>
	`/${(c.path || c.url).replace(/^\/+/, "")}`;

const readV1Comment = (
	row: Record<string, unknown>,
	index: number,
): ComentarioV1Comment => {
	const commentHex = str(row.commentHex);
	if (!commentHex) {
		throw new Error(
			`commento v1 export: comments[${index}] has no commentHex`,
		);
	}
	const path = str(row.path);
	const url = str(row.url);
	if (!path && !url) {
		throw new Error(
			`commento v1 export: comments[${index}] has neither path nor url`,
		);
	}
	return {
		commentHex,
		commenterHex: str(row.commenterHex),
		creationDate: str(row.creationDate),
		deleted: row.deleted === true,
		host: str(row.host),
		markdown: str(row.markdown),
		parentHex: str(row.parentHex),
		path,
		url,
		state: str(row.state),
	};
};

const readV3Page = (
	row: Record<string, unknown>,
	index: number,
): ComentarioV3Page => {
	const id = str(row.id);
	if (!id) throw new Error(`comentario v3 export: pages[${index}] has no id`);
	const title = str(row.title);
	return {
		id,
		domainId: str(row.domainId),
		path: str(row.path),
		...(title ? { title } : {}),
		isReadonly: row.isReadonly === true,
		createdTime: str(row.createdTime),
	};
};

const readV3Comment = (
	row: Record<string, unknown>,
	index: number,
): ComentarioV3Comment => {
	const id = str(row.id);
	if (!id) throw new Error(`comentario v3 export: comments[${index}] has no id`);
	const pageId = str(row.pageId);
	if (!pageId) {
		throw new Error(`comentario v3 export: comments[${index}] has no pageId`);
	}
	const parentId = str(row.parentId);
	const authorName = str(row.authorName);
	return {
		id,
		// Absent, empty and the zero UUID all mean "root". Only the first occurs
		// in practice, but a hand-assembled file may carry either of the others.
		...(parentId && parentId !== V3_ANONYMOUS_ID ? { parentId } : {}),
		pageId,
		markdown: str(row.markdown),
		isApproved: row.isApproved === true,
		isPending: row.isPending === true,
		isDeleted: row.isDeleted === true,
		createdTime: str(row.createdTime),
		editedTime: str(row.editedTime),
		userCreated: str(row.userCreated),
		...(authorName ? { authorName } : {}),
		url: str(row.url),
	};
};

/**
 * Parse a Comentario or Commento export, dispatching on the declared version.
 *
 * The version is read before anything else, because the two shapes share no
 * field names at all — a v1 parser handed a v3 file produces an export full of
 * empty strings rather than an error.
 */
export const parseComentarioExport = (input: string): ComentarioExport => {
	if (input.length > MAX_IMPORT_BYTES) {
		throw new Error(
			`comentario export too large: ${input.length} > ${MAX_IMPORT_BYTES}`,
		);
	}

	let root: unknown;
	try {
		root = JSON.parse(input);
	} catch {
		// The parser's own message quotes a slice of the input on some engines,
		// and an export carries IPs and comment bodies. Replace, never append.
		throw new Error("comentario export: not valid JSON");
	}
	if (!isObject(root)) {
		throw new Error("comentario export: top level is not a JSON object");
	}

	const version = root.version;
	if (typeof version !== "number" || !SUPPORTED_VERSIONS.has(version)) {
		throw new Error(
			`comentario export: version ${JSON.stringify(version)} is not a format this importer has been read against (expected 1 or 3)`,
		);
	}

	if (version === 1) {
		return {
			version: 1,
			comments: arr(root.comments).map(readV1Comment),
			commenters: arr(root.commenters).map((r, i) => {
				const commenterHex = str(r.commenterHex);
				if (!commenterHex) {
					throw new Error(
						`commento v1 export: commenters[${i}] has no commenterHex`,
					);
				}
				return { commenterHex, email: str(r.email), name: str(r.name) };
			}),
		};
	}

	return {
		version: 3,
		pages: arr(root.pages).map(readV3Page),
		comments: arr(root.comments).map(readV3Comment),
		commenters: arr(root.commenters).map((r, i) => {
			const id = str(r.id);
			if (!id) {
				throw new Error(`comentario v3 export: commenters[${i}] has no id`);
			}
			return { id, email: str(r.email), name: str(r.name) };
		}),
	};
};

/**
 * The page URL a v3 comment's permalink points at.
 *
 * `comment.url` is `https://host/path#comentario-<uuid>`, so dropping the
 * fragment leaves the page. Returns null for anything that will not parse,
 * which keeps a malformed url from becoming a malformed link.
 */
const v3PageLink = (commentUrl: string): string | null => {
	if (!commentUrl) return null;
	try {
		const u = new URL(commentUrl);
		u.hash = "";
		return u.toString();
	} catch {
		return null;
	}
};

const v1Status = (c: ComentarioV1Comment): SourceStatus => {
	// Upstream's three-way test, verbatim. A real export's `deleted` is always
	// false and its body is the tombstone; a hand-made one may set the flag.
	if (c.deleted || c.markdown === "" || c.markdown === "[deleted]") {
		return "deleted";
	}
	if (c.state === "approved") return "approved";
	if (c.state === "unapproved") return "pending";
	// Commento's "flagged", and anything a later build added.
	return "spam";
};

const v3Status = (c: ComentarioV3Comment): SourceStatus => {
	if (c.isDeleted) return "deleted";
	if (c.isPending) return "pending";
	if (c.isApproved) return "approved";
	// Not approved and not pending is a comment a moderator rejected.
	return "spam";
};

const toV1Export = (
	exp: Extract<ComentarioExport, { version: 1 }>,
	domain: string | null,
): SourceExport => {
	// Truthiness, not `!== null`: the filter below reads an empty value as "no
	// filter", and `--domain=` on the CLI produces exactly that.
	if (domain) {
		requireKnownIdentifier(
			"commento v1 export: no comment on host",
			domain,
			new Set(exp.comments.map((c) => c.host)),
		);
	}
	const rows = domain
		? exp.comments.filter((c) => c.host === domain)
		: exp.comments;

	const hosts = new Set(rows.map((c) => c.host));
	if (hosts.size > 1) {
		throw new Error(
			`commento v1 export: ${hosts.size} distinct hosts in one file — Garrul slugs are single-site, so import one host at a time (pass a domain to select one): ${listIdentifiers(hosts)}`,
		);
	}

	const byHex = new Map(exp.commenters.map((c) => [c.commenterHex, c]));

	// v1 has no page records. Group on the path and take the earliest comment
	// on it as the page's creation time — Commento exports nothing better.
	const threads = new Map<string, SourceThread>();
	for (const c of rows) {
		const path = v1PagePath(c);
		const at = parseTimeOr(c.creationDate, Date.now());
		const existing = threads.get(path);
		if (!existing) {
			threads.set(path, {
				source_id: path,
				// v1 records no scheme. https is assumed; `safePostUrl` in the
				// core still decides what may reach `posts.url`.
				link: c.host ? `https://${c.host}${path}` : null,
				// Commento exports no page titles at all.
				title: null,
				created_at: at,
				// No read-only flag in v1 either. Absent, not false: the core
				// must not read silence as "open".
			});
			continue;
		}
		if (at < existing.created_at) existing.created_at = at;
	}

	const comments: SourceComment[] = rows.map((c) => {
		// A missing hex is a third spelling of "nobody": `commenters[]` rejects
		// an empty one, so it can never resolve to a registered author, and
		// reading it as registered would emit an author named "anonymous" that
		// claims not to be — the one shape the rest of the pipeline has no way
		// to tell from a real account.
		const anonymous =
			!c.commenterHex || V1_ANONYMOUS_HEXES.has(c.commenterHex);
		const commenter = byHex.get(c.commenterHex);
		const author: SourceAuthor = {
			name: commenter?.name || "anonymous",
			email: commenter?.email || null,
			is_anonymous: anonymous,
			// Anonymous shares one sentinel hex forum-wide, so keying on it
			// would collapse every anonymous commenter onto one ghost. Fall
			// through to the core's name+email seed instead.
			...(anonymous ? {} : { source_id: c.commenterHex }),
		};
		return {
			source_id: c.commentHex,
			thread_source_id: v1PagePath(c),
			// "root" is the sentinel. An unknown hex is left alone: the core
			// already re-roots a comment whose parent it never saw.
			parent_source_id:
				c.parentHex && c.parentHex !== V1_ROOT_PARENT ? c.parentHex : null,
			created_at: parseTimeOr(c.creationDate, Date.now()),
			status: v1Status(c),
			// v1 has no edit timestamp.
			edited_at: null,
			body_md: c.markdown,
			author,
		};
	});

	return { threads: [...threads.values()], comments };
};

const toV3Export = (
	exp: Extract<ComentarioExport, { version: 3 }>,
	domain: string | null,
): SourceExport => {
	// Truthiness, not `!== null`: the filter below reads an empty value as "no
	// filter", and `--domain=` on the CLI produces exactly that.
	if (domain) {
		requireKnownIdentifier(
			"comentario v3 export: no page with domainId",
			domain,
			new Set(exp.pages.map((p) => p.domainId)),
		);
	}
	const pages = domain
		? exp.pages.filter((p) => p.domainId === domain)
		: exp.pages;

	const domains = new Set(pages.map((p) => p.domainId));
	if (domains.size > 1) {
		throw new Error(
			`comentario v3 export: ${domains.size} distinct domains in one file — Garrul slugs are single-site, so import one domain at a time (pass a domainId to select one): ${listIdentifiers(domains)}`,
		);
	}

	const pageById = new Map(pages.map((p) => [p.id, p]));
	const rows = exp.comments.filter((c) => pageById.has(c.pageId));
	const byId = new Map(exp.commenters.map((c) => [c.id, c]));

	// The host lives only on a comment permalink, so a page's link is recovered
	// from the first comment on it that has a parseable one.
	const linkByPage = new Map<string, string>();
	for (const c of rows) {
		if (linkByPage.has(c.pageId)) continue;
		const link = v3PageLink(c.url);
		if (link) linkByPage.set(c.pageId, link);
	}

	// Only pages that actually carry comments are emitted. A v3 export lists
	// every page the widget has ever been mounted on, including ones with zero
	// comments; importing those creates empty `posts` rows for pages Garrul
	// would create on demand anyway, and inflates `pages_total` past what the
	// operator can see in the widget.
	const withComments = new Set(rows.map((c) => c.pageId));
	const threads: SourceThread[] = pages
		.filter((p) => withComments.has(p.id))
		.map((p) => ({
			source_id: p.id,
			link: linkByPage.get(p.id) ?? null,
			title: p.title ?? null,
			created_at: parseTimeOr(p.createdTime, Date.now()),
			// v3 does record this one, and `isReadonly` is always present.
			closed: p.isReadonly,
		}));

	const comments: SourceComment[] = rows.map((c) => {
		const anonymous = !c.userCreated || c.userCreated === V3_ANONYMOUS_ID;
		const commenter = byId.get(c.userCreated);
		const author: SourceAuthor = {
			// An unregistered author's name is on the comment, not in
			// `commenters[]`, which is why the sentinel id must not be the key.
			name: commenter?.name || c.authorName || "anonymous",
			email: commenter?.email || null,
			is_anonymous: anonymous,
			...(anonymous ? {} : { source_id: c.userCreated }),
		};
		const created = parseTimeOr(c.createdTime, Date.now());
		return {
			source_id: c.id,
			thread_source_id: c.pageId,
			parent_source_id: c.parentId ?? null,
			created_at: created,
			status: v3Status(c),
			// Go's zero time already became null in `parseTime`; the core drops
			// anything not strictly after `created_at`.
			edited_at: parseTime(c.editedTime),
			body_md: c.markdown,
			author,
		};
	});

	return { threads, comments };
};

export type ComentarioAdapterOptions = {
	/**
	 * Narrow a multi-domain export to one site: a `domainId` UUID for v3, a
	 * host for v1. Without it a file carrying more than one is refused rather
	 * than flattened, because two sites' `/about` pages would silently become
	 * one Garrul page.
	 */
	domain?: string | null;
};

export const comentarioAdapter = (
	opts: ComentarioAdapterOptions = {},
): ImportAdapter => {
	const domain = opts.domain ?? null;
	return {
		// One tag for both versions: they are one lineage, an operator migrating
		// off Commento is migrating off the same product, and the tag is part of
		// the `(import_source, import_id)` idempotency key, so it can never be
		// re-cut once this has shipped.
		source: "comentario",
		slugFallbackPrefix: "comentario-",
		parse(input: string): SourceExport {
			const exp = parseComentarioExport(input);
			return exp.version === 1
				? toV1Export(exp, domain)
				: toV3Export(exp, domain);
		},
	};
};

export const COMENTARIO_ADAPTER: ImportAdapter = comentarioAdapter();

export const runComentarioImport = (
	db: D1Database,
	input: string,
	secret: string,
	opts: ImportOptions & ComentarioAdapterOptions = {},
): Promise<ImportPlan> =>
	runImport(db, comentarioAdapter({ domain: opts.domain ?? null }), input, secret, opts);
