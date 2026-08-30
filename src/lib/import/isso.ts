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
 * sets `SourceAuthor.source_id` on no live comment and every author is
 * `is_anonymous: true`. Identity is the core's name+email seed, same as
 * Disqus. A blank or absent name becomes the literal `"anonymous"`, matching
 * the other adapters' convention. The one exception is the tombstone ghost
 * below, which is keyed on a constant `source_id` precisely so it can never
 * coincide with a name+email seed.
 *
 * ## Tombstones
 *
 * `mode=4` is isso's soft-delete: `comments.delete()` nulls `author` and
 * `website` and blanks `text` to `""`, but leaves `email` alone. Emitted here
 * as `status: "deleted"`, gated by the core's existing `include_deleted` —
 * no core change for it. The leftover `email` is dropped rather than carried:
 * keeping it would mint a distinct ghost per deleted author — each holding
 * one blank comment, each re-attaching an identity isso had already
 * stripped. Every tombstone lands instead on one dedicated ghost, seeded on
 * `source_id: TOMBSTONE_AUTHOR_ID` rather than on name+email. A name+email
 * seed of `anonymous|` is exactly what a *live* comment posted with no name
 * and no email gets, so seeding tombstones that way would hand a real
 * anonymous commenter's user row every deleted comment on the site — and a
 * user-level ban or anonymise on that row would sweep the tombstones with
 * it. isso only *keeps* a mode-4 row while it still has live children, so
 * every tombstone in a real isso export is load-bearing: dropping it (the
 * default) leaves its replies as roots; `--include-deleted` reproduces
 * isso's exact thread shape, tombstone included.
 *
 * ## Slugs
 *
 * isso has a path, not a URL, so `SourceThread.slug` (core, additive) is set
 * directly from `threads.uri` via `issoSlug` rather than routed through
 * `slugFromLink`: strip leading/trailing slashes, collapse repeated slashes,
 * and fall back to `isso-root` for `/`. Nothing is cut at `?` or `#` — an
 * isso `uri` is an opaque thread id, not a URL, and a query string in one
 * marks a distinct thread rather than a variant of the same page (see
 * `issoSlug`). The core's own `merged_pages` counter still reports it when
 * two uris do collapse onto one slug (`/foo` and `/foo/`).
 *
 * A `uri` is client-declared, so what it derives to is not necessarily a
 * slug the read API will accept — a space, a non-ASCII character, a `:`, a
 * `?` or more than 200 characters all fail `SLUG_RE`. Those get the
 * synthetic `isso-<digest>` slug instead; see `issoSlug`.
 *
 * ## `site`
 *
 * `posts.url` needs a host isso does not have — a thread's `uri` is a path.
 * The optional `site` option (CLI `--site=`, admin `x-import-site`) supplies
 * one: when given, `link = new URL(uri, site).href`; validated with `new
 * URL(site)` and required to be `http:`/`https:`, since an invalid value
 * here would otherwise surface only as a broken permalink much later. When
 * absent, `link` is `null` and permalinks 404 with "post URL not set" until
 * the operator sets one — normal for a source with no URL concept. isso's
 * `uri` is client-declared, so a crafted value (`//evil.example/x`, or an
 * absolute URL of its own) can resolve off the given `site`'s origin; when
 * the resolved link's origin doesn't match `site`'s, `link` falls back to
 * `null` rather than throwing — a poisoned thread still imports its
 * comments, it just gets no permalink.
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
	slugFromPath,
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

/** Only digits, with an optional leading `-`. No sign-plus, no whitespace. */
const ISSO_INT_RE = /^-?\d+$/;

/**
 * Coerce one of isso's integer-typed fields (`id`, `parent`, `mode`) into a
 * number. SQLite row ids are integers, but they can travel through JSON as
 * either a number or a numeric string, so both are accepted; a fraction like
 * `1.5` is not — isso ids are never fractional, so one appearing means the
 * dump is malformed. Returns `null` when `v` cannot be read as an integer.
 *
 * Both branches are deliberately narrower than `Number.isInteger(Number(v))`,
 * which was the earlier test and let three classes of value through that the
 * dumper can never emit:
 *
 * - Past `Number.MAX_SAFE_INTEGER` an integer no longer round-trips, so two
 *   distinct SQLite row ids can collapse onto one JS number — and `import_id`
 *   is the idempotency key. `Number.isSafeInteger` is the check that matters,
 *   not `Number.isInteger`.
 * - `Number()` accepts `"0x10"` and `"1e21"` as integers. A dump written by
 *   `scripts/dump-isso.ts` never contains either, so reading them as 16 and
 *   10^21 is guessing at a hand-edited file rather than refusing it.
 * - `" 12 "` is refused rather than trimmed. Trimming would be a silent
 *   repair of a value the format does not allow, and the failure mode of
 *   getting it wrong (a reply re-rooted onto the wrong parent) is worse than
 *   an operator seeing an indexed error and fixing the file.
 */
const readIssoInt = (v: unknown): number | null => {
	if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
	if (typeof v === "string" && ISSO_INT_RE.test(v)) {
		const n = Number(v);
		return Number.isSafeInteger(n) ? n : null;
	}
	return null;
};

const readIssoComment = (
	row: Record<string, unknown>,
	ti: number,
	ci: number,
): IssoComment => {
	const index = `threads[${ti}].comments[${ci}]`;

	const id = readIssoInt(row.id);
	if (id === null) {
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

	let parent: number | null;
	if (row.parent === null || row.parent === undefined) {
		parent = null;
	} else {
		parent = readIssoInt(row.parent);
		if (parent === null) {
			throw new Error(`isso dump: ${index} has an unusable parent`);
		}
	}

	// Absent or null is the generic format's own shape — `isso import -t
	// generic` has no `mode` column at all, so a dump that came through it
	// carries none and every comment is visible. Present-but-unreadable is a
	// different thing: defaulting `"4"` or `true` to 1 would publish a
	// tombstone, so it is refused rather than guessed at.
	let mode: number;
	if (row.mode === null || row.mode === undefined) {
		mode = 1;
	} else {
		const read = readIssoInt(row.mode);
		if (read === null) {
			throw new Error(`isso dump: ${index} has an unusable mode`);
		}
		mode = read;
	}
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
 * Nine shapes are refused outright: a non-array top level, a thread that
 * isn't an object, a thread with no `comments` array, a thread with no
 * usable id, a comment that isn't an object, a comment with no usable id,
 * a comment with no usable timestamp, a comment with an unusable `parent`,
 * and a comment whose `mode` is present but unreadable — because those are
 * the fields nothing downstream can safely default. An *absent* or null
 * `mode` is not in that list: the generic format has no such column, so its
 * absence means "visible" rather than "malformed". Everything else
 * (`modified_epoch`, `author`, `email`, `text`) degrades to a documented
 * default instead of throwing, matching the other adapters' leniency for
 * optional fields.
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
		if (typeof rawThread.id !== "string") {
			throw new Error(`isso dump: threads[${ti}] has no usable id`);
		}
		const id = rawThread.id;
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

/** The synthetic-slug prefix, shared with the adapter's `slugFallbackPrefix`. */
const ISSO_SLUG_PREFIX = "isso-";

/**
 * The `SourceAuthor.source_id` every tombstone is seeded on.
 *
 * Feeds the core's `authorSeed` as `isso:id:tombstone`, a string no
 * name+email seed (`<name>|<email>`) can produce, so the tombstone ghost is
 * its own user row and never a live commenter's. Part of the identity
 * contract: changing it re-ghosts every previously imported tombstone.
 */
export const TOMBSTONE_AUTHOR_ID = "tombstone";

/**
 * A Garrul slug from an isso thread's `uri` (R2) — `slugFromPath` (core)
 * with this adapter's prefix and `isso-root` for `/`. The path-not-URL
 * treatment (nothing cut at `?` or `#`, an unaddressable uri digested onto
 * `isso-<digest>`) is documented on that helper; it was written here first
 * and lifted when Cusdis needed the same rule for `pages.slug`.
 *
 * Why `?`/`#` matter for isso specifically: the widget sends
 * `location.pathname` unless the host page set `data-isso-id`, and the isso
 * server stores whatever arrived. A `?` or `#` can only be in there because
 * the site owner put it in `data-isso-id`, which means the site had a
 * separate thread on each side of it — a `/?p=1` / `/?p=2` permalink
 * scheme, or `gallery#12` / `gallery#13` anchors.
 */
export const issoSlug = (uri: string): string => slugFromPath(uri, ISSO_SLUG_PREFIX, "isso-root");

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
	// Hoisted once: re-parsing `site` per thread is wasted work, and `site`
	// was already validated as an http(s) origin at adapter construction.
	const siteOrigin = site ? new URL(site).origin : null;

	threads.forEach((t, ti) => {
		if (t.comments.length === 0) return;

		// `created_epoch` is only checked for finiteness at parse time, which
		// `1e308` passes — and `1e308 * 1000` is `Infinity`, which would land
		// in `comments.created_at` as a column that sorts before or after
		// everything forever. The millisecond value is what gets stored, so
		// the millisecond value is what gets validated.
		const epochMs = (seconds: number, ci: number, field: string): number => {
			const ms = Math.round(seconds * 1000);
			if (!Number.isSafeInteger(ms)) {
				throw new Error(
					`isso dump: threads[${ti}].comments[${ci}] has an out-of-range ${field}`,
				);
			}
			return ms;
		};

		// Computed once per comment and reused below — the thread's own
		// `created_at` is the minimum of exactly these values.
		const createdAts = t.comments.map((c, ci) => epochMs(c.created_epoch, ci, "created_epoch"));

		// A loop rather than `Math.min(...createdAts)` — spreading one array
		// element per argument risks the engine's call-argument limit on a
		// thread with a very large comment count.
		let createdAt = Number.POSITIVE_INFINITY;
		for (const ms of createdAts) {
			if (ms < createdAt) createdAt = ms;
		}

		// `uri` is client-declared, so a crafted value (`//evil.example/x`,
		// or an absolute URL) can resolve off `site`'s own origin. Keep the
		// link only when it lands back on that origin; otherwise null it out
		// rather than throwing — one poisoned thread must not abort an
		// otherwise-good import. A `uri` that `new URL` rejects outright
		// (`"http://"`, `"https://["`) takes the same route for the same
		// reason: an uncaught throw here aborts the whole import with a
		// message that names no index at all.
		let resolvedLink: URL | null = null;
		if (site) {
			try {
				resolvedLink = new URL(t.id, site);
			} catch {
				resolvedLink = null;
			}
		}
		const link =
			resolvedLink && resolvedLink.origin === siteOrigin ? resolvedLink.href : null;

		outThreads.push({
			source_id: t.id,
			slug: issoSlug(t.id),
			link,
			title: t.title,
			created_at: createdAt,
		});

		t.comments.forEach((c, ci) => {
			const status = issoStatus(c.mode, `threads[${ti}].comments[${ci}]`);
			comments.push({
				source_id: String(c.id),
				thread_source_id: t.id,
				parent_source_id: c.parent !== null ? String(c.parent) : null,
				created_at: createdAts[ci] as number,
				status,
				edited_at:
					c.modified_epoch != null ? epochMs(c.modified_epoch, ci, "modified_epoch") : null,
				body_md: c.text,
				author:
					status === "deleted"
						? // isso's delete() nulls `author` and `website` but
							// leaves `email` behind, so a tombstone arrives
							// carrying an identity isso itself already stripped
							// from it. Keeping it would seed a ghost on
							// anonymous|<that email> — one per deleted author,
							// each re-attaching a name isso deleted. Dropping it
							// and seeding on `anonymous|` instead would collide
							// with a live no-name, no-email commenter. So the
							// tombstone ghost is keyed on a constant source_id
							// that no name+email seed can ever equal.
							{
								name: "anonymous",
								email: null,
								is_anonymous: true,
								source_id: TOMBSTONE_AUTHOR_ID,
							}
						: {
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

/**
 * Names both doors, because both reach this check and neither operator can
 * see the other's.
 *
 * `POST /admin/api/ops/import-isso` surfaces this message verbatim on the
 * operator card, where the field is called **Site origin** and the header is
 * `x-import-site` — an operator there has no `--site` to correct, so a
 * message that names only the CLI flag reads as a bug in the page.
 */
const SITE_ERROR = "isso import: site must be an http(s) origin (--site / x-import-site)";

const validateSite = (site: string | null): string | null => {
	if (!site) return null;
	let u: URL;
	try {
		u = new URL(site);
	} catch {
		throw new Error(SITE_ERROR);
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		throw new Error(SITE_ERROR);
	}
	return site;
};

export const issoAdapter = (opts: IssoAdapterOptions = {}): ImportAdapter => {
	const site = validateSite(opts.site ?? null);
	return {
		source: "isso",
		slugFallbackPrefix: ISSO_SLUG_PREFIX,
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
