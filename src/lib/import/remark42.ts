/**
 * Remark42 native-export adapter (#107).
 *
 * Reads a Remark42 backup — the format `Native.Export` writes and `backup`
 * saves nightly — and normalises it for the importer core:
 *
 *   line 1               → export metadata (version, per-user and per-post state)
 *   every line after     → one comment
 *   locator.url          → SourceThread   (pages are RECONSTRUCTED; see below)
 *   comment              → SourceComment
 *   comment.user         → SourceAuthor   (users.provider='anon')
 *   comment.pid          → parent_source_id
 *
 * ## The format is framed JSONL, and line 1 is not a comment
 *
 * `Native.Export` writes `exportMeta` first and the comments after it, so the
 * first line is `{"version":1,"users":[…],"posts":[…]}`. Remark42's own struct
 * doc describes the opposite order; the code wins. A parser that treats every
 * line as a comment imports the metadata as a bodyless comment and reports one
 * more than the file contains.
 *
 * The header is tolerated as absent, because the two things that produce these
 * files disagree about whether it is there in practice: a captured export
 * carried `{"version":1,"users":[],"posts":[]}` with both arrays EMPTY, so an
 * adapter that reads `users[]`/`posts[]` for fidelity state has to treat an
 * empty array and a missing header as the same "the source does not say".
 *
 * ## Pages do not exist in the export
 *
 * There is no page or thread record: `locator.url` is the only page key, and
 * `title` hangs off the comment rather than the locator. So threads are
 * synthesised by grouping on the url, the title is taken from the first comment
 * that has one, and `created_at` is the earliest comment on the page — Remark42
 * has no page-creation timestamp to carry.
 *
 * ## The body trap
 *
 * `orig` is the markdown the author typed, `text` is Remark42's rendered HTML.
 * Prefer `orig` — `text` runs through smartypants, so straight quotes come back
 * as guillemets and every source newline as `<br/>`, importing typography the
 * author never wrote.
 *
 * But `orig` is `omitempty` and all three of Remark42's own migrators
 * (disqus.go, wordpress.go, commento.go) set only `Text`. So every comment that
 * reached Remark42 through a migration has no `orig` key at all, and
 * "take orig, ignore text" imports those with an empty body, silently. Hence
 * the fallback through `htmlToMarkdown` — which is why that converter lives in
 * its own module rather than inside the Disqus adapter.
 *
 * ## Identity is the source's id, and that choice is permanent
 *
 * A Remark42 export has NO email field, at any level — not on the user, not on
 * the comment. So `name|email` would reduce to name alone, forking a renamed
 * commenter into two ghosts and merging two people who picked the same display
 * name. `user.id` is the only stable key, so `source_id` is set from day one.
 * Per the core's contract this can never change for a source that has shipped:
 * the seed feeds an HMAC, so a different seed re-ghosts everyone.
 *
 * Note the id is only stable *within one Remark42 instance* — the hash is keyed
 * with that instance's SECRET — and for anonymous users it is derived from the
 * display name, so an anonymous rename does fork after all. It is still the
 * better key: it separates two people who share a name, which name-keying
 * cannot do at any price.
 *
 * Because that key is the whole design, a comment with no `user.id` is a parse
 * error, not a degraded row: the core keys on name+email when `source_id` is
 * empty, which is precisely the merge this adapter exists to avoid.
 *
 * ## Deliberately discarded
 *
 * `score`, `vote`, `votes`, `controversy`, `pin`, `user.admin`, `user.site_id`,
 * and `user.picture` — the last provably carries nothing, its avatar hash being
 * exactly sha1(user.id).
 *
 * `user.ip` and `voted_ips` are dropped as a rule, not as an oversight. Remark42
 * stores the IP already hashed, but a hash is still an identity-linking token
 * and Garrul's rule is that raw or derived IPs are neither stored nor logged.
 * The same rule shapes the parse errors below: a malformed line is exactly the
 * case where the content is unclassified and may carry an `ip` field, so an
 * error names the line NUMBER and the parser's message, never the line.
 */
import {
	type ImportAdapter,
	type ImportOptions,
	type ImportPlan,
	MAX_IMPORT_BYTES,
	type SourceComment,
	type SourceExport,
	type SourceThread,
	runImport,
} from "./core";
import { htmlToMarkdown } from "./html-to-markdown";

/** Export format versions this parser has been read against. */
const SUPPORTED_VERSIONS = new Set([0, 1]);

export type Remark42Meta = {
	version: number;
	/** Per-user state. Empty in a fresh instance's export. */
	users: { id: string; blocked?: { status?: boolean } | undefined; verified?: boolean | undefined }[];
	/** Per-page state. Empty in a fresh instance's export. */
	posts: { url: string; read_only?: boolean | undefined }[];
};

export type Remark42Comment = {
	id: string;
	/** Parent comment id. An empty string — never null, never absent — at root. */
	pid: string;
	/** Rendered HTML. Only read when `orig` is missing. */
	text: string;
	/** The markdown as typed. Absent for anything Remark42 itself imported. */
	orig?: string | undefined;
	user: {
		id: string;
		name: string;
		admin?: boolean | undefined;
	};
	locator: { site?: string | undefined; url: string };
	/** RFC 3339 with nanoseconds and a numeric offset — Go's time.Time default. */
	time: string;
	title?: string | undefined;
	delete?: boolean | undefined;
	edit?: { time?: string | undefined } | undefined;
};

export type Remark42Export = {
	meta: Remark42Meta;
	comments: Remark42Comment[];
};

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * A JSON line, or a throw naming only where it was.
 *
 * `JSON.parse`'s own message quotes a slice of the input on some engines, so it
 * is replaced rather than appended — see the IP note in the module header.
 */
const parseLine = (line: string, lineNo: number): Record<string, unknown> => {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error(`remark42 export: line ${lineNo} is not valid JSON`);
	}
	if (!isObject(value)) {
		throw new Error(`remark42 export: line ${lineNo} is not a JSON object`);
	}
	return value;
};

const EMPTY_META: Remark42Meta = { version: 1, users: [], posts: [] };

const readMeta = (row: Record<string, unknown>, lineNo: number): Remark42Meta => {
	const version = typeof row.version === "number" ? row.version : 1;
	if (!SUPPORTED_VERSIONS.has(version)) {
		throw new Error(
			`remark42 export: line ${lineNo} declares version ${version}, which this importer has not been read against`,
		);
	}
	const users = Array.isArray(row.users) ? row.users : [];
	const posts = Array.isArray(row.posts) ? row.posts : [];
	return {
		version,
		users: users.filter(isObject).map((u) => ({
			id: str(u.id),
			blocked: isObject(u.blocked)
				? { status: u.blocked.status === true }
				: undefined,
			verified: u.verified === true,
		})),
		posts: posts.filter(isObject).map((p) => ({
			url: str(p.url),
			read_only: p.read_only === true,
		})),
	};
};

const readComment = (
	row: Record<string, unknown>,
	lineNo: number,
): Remark42Comment => {
	const id = str(row.id);
	if (!id) throw new Error(`remark42 export: line ${lineNo} has no comment id`);
	const locator = isObject(row.locator) ? row.locator : {};
	const url = str(locator.url);
	if (!url) {
		throw new Error(`remark42 export: line ${lineNo} has no locator.url`);
	}
	const user = isObject(row.user) ? row.user : {};
	const userId = str(user.id);
	// `user.id` is this adapter's identity seed, and the core falls back to
	// name-keying when `source_id` is empty. That fallback is exactly the
	// merge this adapter refuses (see the header): two people who picked the
	// same display name would land on one ghost. An export without it is
	// malformed, so fail the parse rather than degrade the key silently.
	if (!userId) {
		throw new Error(`remark42 export: line ${lineNo} has no user.id`);
	}
	const edit = isObject(row.edit) ? row.edit : undefined;
	return {
		id,
		pid: str(row.pid),
		text: str(row.text),
		// Distinguish "absent" from "present but empty": a deleted comment has
		// its orig blanked, and that must fall through to the same tombstone
		// path as a migrated comment rather than import as an empty body.
		orig: typeof row.orig === "string" && row.orig !== "" ? row.orig : undefined,
		user: {
			id: userId,
			// Remark42 hard-delete rewrites the name to the literal "deleted";
			// nothing here special-cases it, and the core's identity handling
			// then collapses every hard-deleted comment onto one ghost. That is
			// the intended outcome: they are, at the source, one anonymised
			// non-person.
			name: str(user.name) || "anonymous",
			admin: user.admin === true,
		},
		locator: {
			site: typeof locator.site === "string" ? locator.site : undefined,
			url,
		},
		time: str(row.time),
		title: typeof row.title === "string" && row.title ? row.title : undefined,
		delete: row.delete === true,
		edit: edit && typeof edit.time === "string" ? { time: edit.time } : undefined,
	};
};

/**
 * Parse a Remark42 native export.
 *
 * Blank lines are skipped rather than rejected: the file ends with a newline,
 * and an operator who concatenated two backups should not be stopped by the
 * join.
 */
export const parseRemark42Export = (input: string): Remark42Export => {
	if (input.length > MAX_IMPORT_BYTES) {
		throw new Error(
			`remark42 export too large: ${input.length} > ${MAX_IMPORT_BYTES}`,
		);
	}

	let meta = EMPTY_META;
	let sawMeta = false;
	const comments: Remark42Comment[] = [];
	const lines = input.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim();
		if (!line) continue;
		const lineNo = i + 1;
		const row = parseLine(line, lineNo);
		// The header is identified by shape, not by position. A file assembled
		// by hand, or one whose header was stripped, still parses — and a
		// comment can never be mistaken for it, because a comment always has an
		// id and never has a `version`.
		if (!sawMeta && row.version !== undefined && row.id === undefined) {
			meta = readMeta(row, lineNo);
			sawMeta = true;
			continue;
		}
		comments.push(readComment(row, lineNo));
	}

	// One export is one site. Remark42 runs many sites in one instance and
	// exports one at a time, so more than one site id means two files were
	// concatenated — importing them together would merge two comment sections
	// onto whichever pages happen to share a URL.
	const sites = new Set(comments.map((c) => c.locator.site ?? ""));
	if (sites.size > 1) {
		throw new Error(
			`remark42 export: ${sites.size} distinct site ids in one file — import one site at a time`,
		);
	}

	return { meta, comments };
};

const parseTime = (s: string): number => {
	const t = Date.parse(s);
	return Number.isFinite(t) ? t : Date.now();
};

export const REMARK42_ADAPTER: ImportAdapter = {
	source: "remark42",
	slugFallbackPrefix: "remark42-",
	parse(input: string): SourceExport {
		const { meta, comments: rows } = parseRemark42Export(input);

		const readOnly = new Map(meta.posts.map((p) => [p.url, p.read_only === true]));
		const blocked = new Map(
			meta.users.map((u) => [u.id, u.blocked?.status === true]),
		);

		// Pages, reconstructed. First comment on a url wins the title; earliest
		// comment on it becomes its created_at.
		const threads = new Map<string, SourceThread>();
		for (const r of rows) {
			const at = parseTime(r.time);
			const existing = threads.get(r.locator.url);
			if (!existing) {
				threads.set(r.locator.url, {
					source_id: r.locator.url,
					link: r.locator.url,
					title: r.title ?? null,
					created_at: at,
					// undefined, not false, when the header did not list this
					// page: absent means "the source does not say", and the core
					// must not read that as "open".
					// Spread rather than assign: `closed: undefined` is not the
					// same as an absent key under exactOptionalPropertyTypes, and
					// the core reads absence as "the source does not say".
					...(readOnly.has(r.locator.url)
						? { closed: readOnly.get(r.locator.url) === true }
						: {}),
				});
				continue;
			}
			if (at < existing.created_at) existing.created_at = at;
			if (!existing.title && r.title) existing.title = r.title;
		}

		const comments: SourceComment[] = rows.map((r) => ({
			source_id: r.id,
			thread_source_id: r.locator.url,
			// Root is an empty string here, never null and never absent.
			parent_source_id: r.pid || null,
			created_at: parseTime(r.time),
			// Remark42 has no moderation queue and no spam verdict, so 'pending'
			// and 'spam' have no source and are never emitted. A deleted row has
			// had its body blanked at the source, so it imports as a tombstone
			// or, by default, is skipped — the same treatment Disqus's deleted
			// rows get.
			status: r.delete ? "deleted" : "approved",
			edited_at: r.edit?.time ? parseTime(r.edit.time) : null,
			body_md: r.orig ?? htmlToMarkdown(r.text),
			author: {
				name: r.user.name,
				// Not "not found" — the field does not exist in this format.
				email: null,
				// No is_anonymous field either. Remark42 encodes the provider in
				// the id: an anonymous commenter is `anonymous_<hash>`, an OAuth
				// one `github_<id>`.
				is_anonymous: r.user.id.startsWith("anonymous_"),
				source_id: r.user.id,
				...(blocked.has(r.user.id)
					? { is_banned: blocked.get(r.user.id) === true }
					: {}),
			},
		}));

		return { threads: [...threads.values()], comments };
	},
};

export const runRemark42Import = (
	db: D1Database,
	input: string,
	secret: string,
	opts: ImportOptions = {},
): Promise<ImportPlan> => runImport(db, REMARK42_ADAPTER, input, secret, opts);
