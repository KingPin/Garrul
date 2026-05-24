import { CURRENT_RENDERER_VERSION, renderMarkdown } from "../lib/markdown";

export type RerenderCursor = { created_at: number; id: string };

export type RerenderBatchResult = {
	processed: number;
	next_cursor: RerenderCursor | null;
};

export type RerenderStats = {
	current_version: number;
	up_to_date: number;
	stale: number;
	oldest_version: number | null;
};

export const rerenderStats = async (
	db: D1Database,
): Promise<RerenderStats> => {
	const row = await db
		.prepare(
			`SELECT
        COUNT(CASE WHEN renderer_version >= ? THEN 1 END) AS up_to_date,
        COUNT(CASE WHEN renderer_version <  ? THEN 1 END) AS stale,
        MIN(CASE WHEN renderer_version < ? THEN renderer_version END)
                                                           AS oldest_version
        FROM comments`,
		)
		.bind(
			CURRENT_RENDERER_VERSION,
			CURRENT_RENDERER_VERSION,
			CURRENT_RENDERER_VERSION,
		)
		.first<{
			up_to_date: number;
			stale: number;
			oldest_version: number | null;
		}>();
	return {
		current_version: CURRENT_RENDERER_VERSION,
		up_to_date: row?.up_to_date ?? 0,
		stale: row?.stale ?? 0,
		oldest_version: row?.oldest_version ?? null,
	};
};

export const rerenderBatch = async (
	db: D1Database,
	batchSize: number,
	cursor: RerenderCursor | null,
): Promise<RerenderBatchResult> => {
	const where = cursor
		? `renderer_version < ? AND (created_at, id) > (?, ?)`
		: `renderer_version < ?`;
	const binds = cursor
		? [CURRENT_RENDERER_VERSION, cursor.created_at, cursor.id, batchSize]
		: [CURRENT_RENDERER_VERSION, batchSize];

	const result = await db
		.prepare(
			`SELECT id, body_md, created_at FROM comments
        WHERE ${where}
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
		)
		.bind(...binds)
		.all<{ id: string; body_md: string; created_at: number }>();

	const rows = result.results ?? [];
	if (rows.length === 0) return { processed: 0, next_cursor: null };

	const stmts = rows.map((r) => {
		const html = renderMarkdown(r.body_md);
		return db
			.prepare(
				`UPDATE comments
            SET body_html = ?, renderer_version = ?
          WHERE id = ?`,
			)
			.bind(html, CURRENT_RENDERER_VERSION, r.id);
	});
	await db.batch(stmts);

	const last = rows[rows.length - 1];
	const next_cursor =
		rows.length < batchSize || !last
			? null
			: { created_at: last.created_at, id: last.id };
	return { processed: rows.length, next_cursor };
};
