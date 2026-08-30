/**
 * Cusdis importer (#109).
 *
 * Cusdis (`djyde/cusdis`) is deprecated upstream and ships no export — no
 * dashboard button, no CLI, no export endpoint. Its `db.sqlite` *is* the
 * data store, so like isso it is a Class B source: `scripts/dump-cusdis.ts`
 * is a node-only dumper that reads the SQLite file and emits a JSON
 * intermediate, and this file is an ordinary adapter over that intermediate.
 * It never touches SQLite, so no driver reaches the Worker bundle.
 *
 *   { source: "cusdis", version: 1,
 *     projects: [ { id, title,
 *       pages: [ { id, slug, url, title,
 *         comments: [ { id, parent_id, created_at, updated_at, deleted_at,
 *                       approved, by_nickname, by_email, content } ] } ] } ] }
 *
 * Every id is Cusdis' own UUID string. Timestamps are epoch milliseconds —
 * Garrul's own unit — so they pass through untouched.
 *
 * ## One instance, many projects
 *
 * A Cusdis "project" is one site; one database holds every project the
 * operator ever created, and pages on two projects can carry the same
 * `slug` (both sites have an `/about`). Garrul slugs are single-site, so a
 * file with more than one project is refused unless `project` names one —
 * by **id**, never by title, because Cusdis puts no uniqueness constraint
 * on `projects.title`. Same policy as the Comentario adapter's `domain`.
 *
 * Cusdis soft-deletes a project the way it soft-deletes a comment — the row
 * and everything under it stay, `deleted_at` is set, the dashboard hides
 * it. Without a filter only **live** projects count: a file with one live
 * project imports it, several live ones are refused as above, and a file
 * whose every project is deleted is refused rather than imported, naming
 * them. An explicit `project` id may name a deleted project — the operator
 * who types an id has seen the refusal, and the data is still there.
 *
 * ## No user accounts
 *
 * A Cusdis commenter is never a registered user: identity lives on the
 * comment row itself as `by_nickname` (required) and `by_email` (optional,
 * often empty). So, like isso and Disqus, every author here is
 * `is_anonymous: true` with no `source_id`, and identity is the core's
 * name+email seed. A blank nickname becomes the literal `"anonymous"`.
 * There is no ban flag to carry — Cusdis has no concept of a banned
 * commenter.
 *
 * ## Soft delete
 *
 * `deleted_at` is Cusdis' soft delete, set by the dashboard's delete
 * action. It touches only that column — nickname, email and content stay
 * on the row, and replies are not cascaded. Emitted here as
 * `status: "deleted"`, gated by the core's `include_deleted`; a deleted
 * parent's live replies survive either way (the core re-roots them when
 * the parent is skipped), and a deleted comment carries its real author
 * rather than a tombstone ghost, because the data is still there.
 *
 * ## Moderation
 *
 * `approved` is Cusdis' one moderation bit: `false` on every new comment
 * until the dashboard (or the email one-click link) approves it, and an
 * unapproved comment is invisible to the widget. It maps onto `pending`,
 * which the core never gates — a comment awaiting moderation is unfinished
 * work, not junk. Cusdis has no spam state, so `include_spam` is a no-op.
 *
 * ## `updated_at` is not an edit
 *
 * Cusdis has no comment-edit feature — not for commenters, not in the
 * dashboard. Its `updated_at` is Prisma's `@updatedAt`, which bumps on
 * *any* update to the row, and the only updates Cusdis makes are approve
 * and delete. Deriving `edited_at` from it would mark every moderated
 * comment "edited" in Garrul's UI for something the commenter never did,
 * so `edited_at` is always `null` here.
 *
 * ## Slugs and links
 *
 * `Page.slug` is whatever the host page passed as `data-page-id` — a
 * client-declared path by convention (`/hello-world`), but it can be
 * anything. It goes through the shared `slugFromPath`: leading/trailing
 * slashes stripped, runs collapsed, and a result the read API would reject
 * (`SLUG_RE`) replaced by a stable digest under the `cusdis-` prefix.
 * `Page.url` is likewise client-declared (`data-page-url`) and nullable.
 * Without a `site`, it is used whenever it parses as an http(s) URL. With
 * one, the optional `site` origin pins every link: a `url` on that origin
 * is kept, anything else falls back to resolving the slug against `site`,
 * same-origin only — so neither a slug of `//evil.example/x` nor a `url`
 * of `https://evil.example/x` can smuggle a foreign permalink past the
 * origin the operator named. Without either, the link is `null`.
 *
 * ## Threads keyed on page id, not slug
 *
 * `thread_source_id` is the page's UUID. Cusdis' `parentId` is a global
 * self-relation that its own UI never points across pages, but a
 * hand-edited database could; the core re-roots a reply whose parent sits
 * on another thread, so the adapter passes `parent_id` through as it is.
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
	listIdentifiers,
	requireKnownIdentifier,
	resolveOnSite,
	runImport,
	slugFromPath,
	validateSiteOrigin,
} from "./core";

export type CusdisComment = {
	id: string;
	parent_id: string | null;
	created_at: number;
	updated_at: number | null;
	deleted_at: number | null;
	approved: boolean;
	by_nickname: string;
	by_email: string | null;
	content: string;
};

export type CusdisPage = {
	id: string;
	slug: string;
	url: string | null;
	title: string | null;
	comments: CusdisComment[];
};

export type CusdisProject = {
	id: string;
	title: string;
	deleted_at: number | null;
	pages: CusdisPage[];
};

export type CusdisDump = {
	projects: CusdisProject[];
};

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Field readers. Every error names the JSON path and the field, never the
 * value — a value could be a nickname, an email or a comment body, and
 * parse errors end up in the admin UI and the CLI's stderr.
 */
const readString = (v: unknown, where: string): string => {
	if (typeof v !== "string") throw new Error(`cusdis dump: ${where} is not a string`);
	return v;
};

const readNullableString = (v: unknown, where: string): string | null => {
	if (v === null || v === undefined) return null;
	return readString(v, where);
};

const readEpochMs = (v: unknown, where: string): number => {
	if (typeof v !== "number" || !Number.isSafeInteger(v)) {
		throw new Error(`cusdis dump: ${where} is not an epoch-millisecond integer`);
	}
	return v;
};

const readNullableEpochMs = (v: unknown, where: string): number | null => {
	if (v === null || v === undefined) return null;
	return readEpochMs(v, where);
};

const readComment = (raw: unknown, where: string): CusdisComment => {
	if (!isObject(raw)) throw new Error(`cusdis dump: ${where} is not an object`);
	if (typeof raw.approved !== "boolean") {
		throw new Error(`cusdis dump: ${where}.approved is not a boolean`);
	}
	return {
		id: readString(raw.id, `${where}.id`),
		parent_id: readNullableString(raw.parent_id, `${where}.parent_id`),
		created_at: readEpochMs(raw.created_at, `${where}.created_at`),
		updated_at: readNullableEpochMs(raw.updated_at, `${where}.updated_at`),
		deleted_at: readNullableEpochMs(raw.deleted_at, `${where}.deleted_at`),
		approved: raw.approved,
		by_nickname: readString(raw.by_nickname, `${where}.by_nickname`),
		by_email: readNullableString(raw.by_email, `${where}.by_email`),
		content: readString(raw.content, `${where}.content`),
	};
};

const readPage = (raw: unknown, where: string): CusdisPage => {
	if (!isObject(raw)) throw new Error(`cusdis dump: ${where} is not an object`);
	if (!Array.isArray(raw.comments)) {
		throw new Error(`cusdis dump: ${where} has no comments array`);
	}
	return {
		id: readString(raw.id, `${where}.id`),
		slug: readString(raw.slug, `${where}.slug`),
		url: readNullableString(raw.url, `${where}.url`),
		title: readNullableString(raw.title, `${where}.title`),
		comments: raw.comments.map((c, ci) => readComment(c, `${where}.comments[${ci}]`)),
	};
};

const readProject = (raw: unknown, where: string): CusdisProject => {
	if (!isObject(raw)) throw new Error(`cusdis dump: ${where} is not an object`);
	if (!Array.isArray(raw.pages)) throw new Error(`cusdis dump: ${where} has no pages array`);
	return {
		id: readString(raw.id, `${where}.id`),
		title: readString(raw.title, `${where}.title`),
		deleted_at: readNullableEpochMs(raw.deleted_at, `${where}.deleted_at`),
		pages: raw.pages.map((p, pi) => readPage(p, `${where}.pages[${pi}]`)),
	};
};

/**
 * Parse the dumper's JSON. Strict on shape: the intermediate is a contract
 * between two files in this repo, and a document that does not match it is
 * not a Cusdis dump, whatever else it may be.
 */
export const parseCusdisDump = (input: string): CusdisDump => {
	if (input.length > MAX_IMPORT_BYTES) {
		throw new Error(`cusdis dump too large: ${input.length} > ${MAX_IMPORT_BYTES}`);
	}

	let root: unknown;
	try {
		root = JSON.parse(input);
	} catch {
		throw new Error("cusdis dump: not valid JSON");
	}
	if (!isObject(root)) throw new Error("cusdis dump: top level is not an object");
	if (root.source !== "cusdis") throw new Error('cusdis dump: source is not "cusdis"');
	if (root.version !== 1) throw new Error("cusdis dump: unsupported version");
	if (!Array.isArray(root.projects)) throw new Error("cusdis dump: no projects array");

	return {
		projects: root.projects.map((p, pi) => readProject(p, `projects[${pi}]`)),
	};
};

const CUSDIS_SLUG_PREFIX = "cusdis-";

/** A Garrul slug from a Cusdis page slug (a client-declared path). */
export const cusdisSlug = (slug: string): string =>
	slugFromPath(slug, CUSDIS_SLUG_PREFIX, "cusdis-root");

/**
 * `deleted_at` wins over `approved`: Cusdis leaves `approved` as it was
 * when it soft-deletes, so a deleted row is usually also `approved: true`.
 */
export const cusdisStatus = (c: Pick<CusdisComment, "approved" | "deleted_at">): SourceStatus => {
	if (c.deleted_at !== null) return "deleted";
	return c.approved ? "approved" : "pending";
};

/**
 * `Page.url` is client-declared. Accept it only when it parses as http(s);
 * anything else (a relative path, a `javascript:` URL, garbage) falls
 * through to site resolution or `null`.
 */
const pageUrl = (url: string | null): URL | null => {
	if (!url) return null;
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:" ? u : null;
	} catch {
		return null;
	}
};

/**
 * The permalink for a page — see "Slugs and links" in the header.
 *
 * Without `site` the page's own `url` is the only source of a link, so it is
 * taken as it is. With `site`, the operator has named the origin every
 * permalink must land on, and a client-declared `url` gets no more trust
 * than a client-declared slug: off-origin, it is set aside and the slug is
 * resolved against `site` instead (which may itself come back null).
 */
const pageLink = (page: CusdisPage, site: string | null): string | null => {
	const own = pageUrl(page.url);
	if (!site) return own?.href ?? null;
	if (own && own.origin === new URL(site).origin) return own.href;
	return resolveOnSite(page.slug, site);
};

const selectProject = (dump: CusdisDump, project: string | null): CusdisProject | null => {
	// Truthiness, not `!== null`: an empty value reads as "no filter", and
	// `--project=` on the CLI produces exactly that.
	if (project) {
		requireKnownIdentifier(
			"cusdis dump: no project with id",
			project,
			new Set(dump.projects.map((p) => p.id)),
		);
		return dump.projects.find((p) => p.id === project) ?? null;
	}
	// Name both id and title: the id is what `--project` takes, the title
	// is how the operator knows their sites apart.
	const named = (projects: CusdisProject[]) =>
		listIdentifiers(new Set(projects.map((p) => `${p.id} (${p.title})`)));
	const live = dump.projects.filter((p) => p.deleted_at === null);
	if (live.length > 1) {
		const deleted = dump.projects.length - live.length;
		throw new Error(
			`cusdis dump: ${live.length} projects in one file — Garrul slugs are single-site, so import one project at a time (pass a project id to select one): ${named(live)}${deleted > 0 ? ` (not counting ${deleted} deleted in Cusdis)` : ""}`,
		);
	}
	if (live.length === 0 && dump.projects.length > 0) {
		// Nothing live to fall back on. Importing a deleted site because it
		// happened to be the only one would be a surprise; refusing and naming
		// it lets the operator opt in by id.
		throw new Error(
			`cusdis dump: every project in this file is deleted in Cusdis — pass a project id to import one anyway: ${named(dump.projects)}`,
		);
	}
	return live[0] ?? null;
};

const toExport = (dump: CusdisDump, project: string | null, site: string | null): SourceExport => {
	const threads: SourceThread[] = [];
	const comments: SourceComment[] = [];
	const selected = selectProject(dump, project);
	if (!selected) return { threads, comments };

	for (const page of selected.pages) {
		// A page with no comments is a row Cusdis created the first time the
		// widget mounted there; nothing to import.
		if (page.comments.length === 0) continue;

		let createdAt = Number.POSITIVE_INFINITY;
		for (const c of page.comments) {
			if (c.created_at < createdAt) createdAt = c.created_at;
		}

		threads.push({
			source_id: page.id,
			slug: cusdisSlug(page.slug),
			link: pageLink(page, site),
			title: page.title,
			created_at: createdAt,
		});

		for (const c of page.comments) {
			comments.push({
				source_id: c.id,
				thread_source_id: page.id,
				// Passed through as-is. A parent that is missing, on another
				// page, or the comment itself is re-rooted by the core.
				parent_source_id: c.parent_id,
				created_at: c.created_at,
				status: cusdisStatus(c),
				edited_at: null,
				body_md: c.content,
				author: {
					name: c.by_nickname.trim() || "anonymous",
					email: c.by_email || null,
					is_anonymous: true,
				},
			});
		}
	}

	return { threads, comments };
};

export type CusdisAdapterOptions = {
	/** Cusdis project **id** to import when the dump holds more than one. */
	project?: string | null;
	/** http(s) origin used to build page links for pages that have no `url`. */
	site?: string | null;
};

export const cusdisAdapter = (opts: CusdisAdapterOptions = {}): ImportAdapter => {
	const site = validateSiteOrigin("cusdis", opts.site ?? null);
	const project = opts.project ?? null;
	return {
		source: "cusdis",
		slugFallbackPrefix: CUSDIS_SLUG_PREFIX,
		parse(input: string): SourceExport {
			return toExport(parseCusdisDump(input), project, site);
		},
	};
};

export const CUSDIS_ADAPTER: ImportAdapter = cusdisAdapter();

export const runCusdisImport = (
	db: D1Database,
	input: string,
	secret: string,
	opts: ImportOptions & CusdisAdapterOptions = {},
): Promise<ImportPlan> =>
	runImport(
		db,
		cusdisAdapter({ project: opts.project ?? null, site: opts.site ?? null }),
		input,
		secret,
		opts,
	);
