/**
 * isso importer (#108).
 *
 * isso (`isso-comments/isso`) ships no export command at all — `comments.db`
 * *is* the data store, read directly by the isso server itself. `scripts/
 * dump-isso.ts` is a node-only dumper that reads that SQLite file and emits
 * a JSON intermediate mirroring isso's own generic import format
 * (`isso import -t generic`, verified against `isso/migrate.py`'s `Generic`
 * class) plus a few additive fields the format doesn't carry on its own:
 * `parent`, `mode`, `created_epoch`, `modified_epoch`. This file is an
 * ordinary adapter over that intermediate — it never touches SQLite, so no
 * driver reaches the Worker bundle.
 *
 *   [ { id, title, comments: [ { id, parent, mode, created, created_epoch,
 *       modified_epoch, author, email, website, remote_addr, text } ] } ]
 *
 * `id` is `threads.uri` verbatim — a path, not a URL. `created` is
 * `created_epoch` formatted as UTC `YYYY-MM-DD HH:MM:SS`; `created_epoch`
 * itself is the exact float this adapter uses, so a comment carrying
 * either one is accepted (see `parseIssoDump`).
 *
 * ## No user accounts
 *
 * isso has none — every commenter is anonymous by construction, so unlike
 * Remark42 (which keys a registered author on its own user id) this adapter
 * never sets `SourceAuthor.source_id` and every author is `is_anonymous:
 * true`. Identity is the core's name+email seed, same as Disqus. A blank or
 * absent name becomes the literal `"anonymous"`, matching the other
 * adapters' convention.
 *
 * ## Tombstones
 *
 * `mode=4` is isso's soft-delete: `comments.delete()` nulls `author` and
 * `website` and blanks `text` to `""`, but leaves `email` alone. Emitted here
 * as `status: "deleted"`, gated by the core's existing `include_deleted` —
 * no core change for it. isso only *keeps* a mode-4 row while it still has
 * live children, so every tombstone in a real isso export is load-bearing:
 * dropping it (the default) leaves its replies as roots; `--include-deleted`
 * reproduces isso's exact thread shape, tombstone included.
 *
 * ## Slugs
 *
 * isso has a path, not a URL, so `SourceThread.slug` (core, additive) is set
 * directly from `threads.uri` via `issoSlug` rather than routed through
 * `slugFromLink`: drop the query string, strip leading/trailing slashes,
 * collapse repeated slashes, and fall back to `isso-root` for `/`. The
 * core's own `merged_pages` counter still reports it when that collapses two
 * source threads (e.g. `/foo/` and `/foo/?page=2`) onto one slug.
 *
 * ## `site`
 *
 * `posts.url` needs a host isso does not have — a thread's `uri` is a path.
 * The optional `site` option (CLI `--site=`, admin `x-import-site`) supplies
 * one: when given, `link = new URL(uri, site).href`; validated with `new
 * URL(site)` and required to be `http:`/`https:`, since an invalid value
 * here would otherwise surface only as a broken permalink much later. When
 * absent, `link` is `null` and permalinks 404 with "post URL not set" until
 * the operator sets one — normal for a source with no URL concept.
 *
 * ## Deliberately discarded
 *
 * `remote_addr` — isso anonymises it to a /24 and Garrul HMAC-hashes its own,
 * so neither format's value is useful to the other. `website` — no author-URL
 * column exists on `SourceAuthor`. `likes`/`dislikes`/`voters`/`notification`
 * never even reach the intermediate (the dumper never emits them); noted here
 * so a reader does not go looking for them on this side either.
 *
 * ## Timestamps
 *
 * isso's `created`/`modified` are epoch **float seconds**; `comments.
 * created_at`/`edited_at` are epoch milliseconds, so every value here is
 * `Math.round(x * 1000)`.
 */
import {
	type ImportAdapter,
	type ImportOptions,
	type ImportPlan,
	MAX_IMPORT_BYTES,
	type SourceComment,
	type SourceExport,
	type SourceStatus,
	type SourceThread,
	runImport,
} from "./core";

/** One comment in the intermediate, after parsing and defaulting. */
export type IssoComment = {
	id: number;
	parent: number | null;
	mode: number;
	/** Resolved from `created_epoch` when finite, else from `created`. */
	created_epoch: number;
	modified_epoch: number | null;
	author: string | null;
	email: string | null;
	text: string;
};

/** One thread in the intermediate, after parsing and defaulting. */
export type IssoThread = {
	id: string;
	title: string | null;
	comments: IssoComment[];
};

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const ISSO_CREATED_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * `created` as UTC epoch milliseconds, or null when it doesn't match the
 * dumper's `YYYY-MM-DD HH:MM:SS` shape.
 *
 * Parsed by hand rather than with `Date.parse`: engines disagree on how a
 * space-separated, non-ISO string like this one is interpreted, and several
 * read it as local time rather than UTC — which is exactly the ambiguity
 * `created_epoch` exists to route around when it's present.
 */
const parseIssoCreatedString = (s: string): number | null => {
	const m = ISSO_CREATED_RE.exec(s);
	if (!m) return null;
	const [, y, mo, d, h, mi, se] = m as unknown as [
		string,
		string,
		string,
		string,
		string,
		string,
		string,
	];
	const ms = Date.UTC(
		Number(y),
		Number(mo) - 1,
		Number(d),
		Number(h),
		Number(mi),
		Number(se),
	);
	return Number.isFinite(ms) ? ms : null;
};

const readIssoComment = (
	row: Record<string, unknown>,
	ti: number,
	ci: number,
): IssoComment => {
	const index = `threads[${ti}].comments[${ci}]`;

	const rawId = row.id;
	let id: number;
	if (typeof rawId === "number" && Number.isFinite(rawId)) {
		id = rawId;
	} else if (
		typeof rawId === "string" &&
		rawId.trim() !== "" &&
		Number.isFinite(Number(rawId))
	) {
		id = Number(rawId);
	} else {
		throw new Error(`isso dump: ${index} has no usable id`);
	}

	let created_epoch: number;
	if (typeof row.created_epoch === "number" && Number.isFinite(row.created_epoch)) {
		created_epoch = row.created_epoch;
	} else if (typeof row.created === "string") {
		const ms = parseIssoCreatedString(row.created);
		if (ms === null) {
			throw new Error(`isso dump: ${index} has no usable timestamp`);
		}
		created_epoch = ms / 1000;
	} else {
		throw new Error(`isso dump: ${index} has no usable timestamp`);
	}

	const parent =
		typeof row.parent === "number" && Number.isFinite(row.parent) ? row.parent : null;
	const mode = typeof row.mode === "number" && Number.isFinite(row.mode) ? row.mode : 1;
	const modified_epoch =
		typeof row.modified_epoch === "number" && Number.isFinite(row.modified_epoch)
			? row.modified_epoch
			: null;
	const author = typeof row.author === "string" ? row.author : null;
	const email = typeof row.email === "string" ? row.email : null;
	// Tombstones (mode 4) blank this to "" at the source; a missing or
	// wrong-typed value gets the same treatment rather than a thrown error —
	// there is no useful signal to preserve either way.
	const text = typeof row.text === "string" ? row.text : "";

	return { id, parent, mode, created_epoch, modified_epoch, author, email, text };
};

/**
 * Parse the JSON intermediate `scripts/dump-isso.ts` produces.
 *
 * Only four shapes are refused outright — a non-array top level, a thread
 * with no `comments` array, a comment with no usable id, and a comment with
 * no usable timestamp — because those are the fields nothing downstream can
 * safely default. Everything else (`parent`, `mode`, `modified_epoch`,
 * `author`, `email`, `text`) degrades to a documented default instead of
 * throwing, matching the other adapters' leniency for optional fields.
 *
 * Errors name a `threads[i]` / `threads[i].comments[j]` index only, never a
 * value — the intermediate carries names, emails and comment bodies.
 */
export const parseIssoDump = (input: string): IssoThread[] => {
	if (input.length > MAX_IMPORT_BYTES) {
		throw new Error(`isso dump too large: ${input.length} > ${MAX_IMPORT_BYTES}`);
	}

	let root: unknown;
	try {
		root = JSON.parse(input);
	} catch {
		// The parser's own message can quote a slice of the input on some
		// engines, and a dump carries names, emails and comment bodies.
		throw new Error("isso dump: not valid JSON");
	}
	if (!Array.isArray(root)) {
		throw new Error("isso dump: top level is not an array");
	}

	return root.map((rawThread, ti) => {
		if (!isObject(rawThread)) {
			throw new Error(`isso dump: threads[${ti}] is not an object`);
		}
		if (!Array.isArray(rawThread.comments)) {
			throw new Error(`isso dump: threads[${ti}] has no comments array`);
		}
		const id = typeof rawThread.id === "string" ? rawThread.id : "";
		const title = typeof rawThread.title === "string" ? rawThread.title : null;
		const comments = rawThread.comments.map((rawComment, ci) => {
			if (!isObject(rawComment)) {
				throw new Error(`isso dump: threads[${ti}].comments[${ci}] is not an object`);
			}
			return readIssoComment(rawComment, ti, ci);
		});
		return { id, title, comments };
	});
};

/**
 * A Garrul slug from an isso thread's `uri` (R2).
 *
 * `slugFromLink` (core) drops a query string via `URL.pathname` — this
 * mirrors that by splitting on `?` before stripping slashes, since a path
 * has no `URL` to parse it with. Repeated slashes collapse the same way
 * `slugFromLink` collapses a link's path. `/` has nothing left once
 * stripped, so it gets the same synthetic treatment as any other
 * link-less thread: `isso-root`.
 */
export const issoSlug = (uri: string): string => {
	const withoutQuery = uri.split("?")[0] ?? uri;
	const collapsed = withoutQuery.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
	return collapsed || "isso-root";
};

/**
 * isso's `mode` integer, mapped onto Garrul's moderation vocabulary.
 *
 * 1 = visible, 2 = the moderation queue, 4 = isso's soft-delete tombstone.
 * Any other value is refused rather than guessed at — isso has never shipped
 * a fifth state, so one appearing means the dump is malformed or from a
 * build this adapter hasn't been read against.
 */
export const issoStatus = (mode: number, index: string): SourceStatus => {
	switch (mode) {
		case 1:
			return "approved";
		case 2:
			return "pending";
		case 4:
			return "deleted";
		default:
			throw new Error(`isso import: ${index} has an unrecognised mode ${mode}`);
	}
};

/**
 * Normalise the parsed intermediate into the core's source-agnostic shape.
 *
 * Threads with zero comments are dropped (R7) — isso keeps a `threads` row
 * for any page the widget was ever mounted on, and importing those creates
 * empty `posts` rows Garrul would create on demand anyway.
 */
const toExport = (threads: IssoThread[], site: string | null): SourceExport => {
	const outThreads: SourceThread[] = [];
	const comments: SourceComment[] = [];

	threads.forEach((t, ti) => {
		if (t.comments.length === 0) return;

		const createdAts = t.comments.map((c) => Math.round(c.created_epoch * 1000));
		outThreads.push({
			source_id: t.id,
			slug: issoSlug(t.id),
			link: site ? new URL(t.id, site).href : null,
			title: t.title,
			created_at: Math.min(...createdAts),
		});

		t.comments.forEach((c, ci) => {
			const status = issoStatus(c.mode, `threads[${ti}].comments[${ci}]`);
			comments.push({
				source_id: String(c.id),
				thread_source_id: t.id,
				parent_source_id: c.parent !== null ? String(c.parent) : null,
				created_at: Math.round(c.created_epoch * 1000),
				status,
				edited_at: c.modified_epoch != null ? Math.round(c.modified_epoch * 1000) : null,
				body_md: c.text,
				author: {
					name: (c.author ?? "").trim() || "anonymous",
					email: c.email || null,
					is_anonymous: true,
				},
			});
		});
	});

	return { threads: outThreads, comments };
};

export type IssoAdapterOptions = {
	/**
	 * The site's own origin, for permalinks isso itself has no concept of.
	 * `posts.url` needs a host; a thread's `uri` is only ever a path. Must
	 * parse as an `http:`/`https:` URL — validated eagerly, at adapter
	 * construction, rather than left to surface as a broken permalink later.
	 */
	site?: string | null;
};

const validateSite = (site: string | null): string | null => {
	if (!site) return null;
	let u: URL;
	try {
		u = new URL(site);
	} catch {
		throw new Error("isso import: --site must be an http(s) origin");
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		throw new Error("isso import: --site must be an http(s) origin");
	}
	return site;
};

export const issoAdapter = (opts: IssoAdapterOptions = {}): ImportAdapter => {
	const site = validateSite(opts.site ?? null);
	return {
		source: "isso",
		slugFallbackPrefix: "isso-",
		parse(input: string): SourceExport {
			return toExport(parseIssoDump(input), site);
		},
	};
};

export const ISSO_ADAPTER: ImportAdapter = issoAdapter();

export const runIssoImport = (
	db: D1Database,
	input: string,
	secret: string,
	opts: ImportOptions & IssoAdapterOptions = {},
): Promise<ImportPlan> =>
	runImport(db, issoAdapter({ site: opts.site ?? null }), input, secret, opts);
