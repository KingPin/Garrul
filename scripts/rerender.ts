#!/usr/bin/env tsx
/**
 * Re-render stored comments after a sanitizer change.
 *
 * Bump CURRENT_RENDERER_VERSION in src/lib/markdown.ts, then run:
 *   npm run rerender              # local D1 (Miniflare)
 *   npm run rerender -- --remote  # production D1
 *
 * Pages through comments whose `renderer_version` is below the current
 * value, re-renders body_md → body_html, and writes back via UPDATE.
 * Each page is a single `wrangler d1 execute` call so the work is
 * resumable: a crash in the middle leaves the table in a consistent
 * state where the next run picks up where this one stopped.
 *
 * Idempotent: a comment already at CURRENT_RENDERER_VERSION is skipped
 * by the WHERE clause.
 */
import { execFileSync } from "node:child_process";

import {
	CURRENT_RENDERER_VERSION,
	renderMarkdown,
} from "../src/lib/markdown";

const DB_NAME = "garrul-db";
const PAGE_SIZE = 100;
const remoteFlag = process.argv.includes("--remote") ? "--remote" : "--local";

type StaleRow = {
	id: string;
	body_md: string;
	created_at: number;
};

const wrangler = (args: string[]): string =>
	execFileSync("wrangler", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

const d1Json = (sql: string): unknown => {
	const out = wrangler([
		"d1",
		"execute",
		DB_NAME,
		remoteFlag,
		"--json",
		"--command",
		sql,
	]);
	try {
		return JSON.parse(out);
	} catch {
		return null;
	}
};

const sqlEsc = (s: string): string => s.replace(/'/g, "''");

const fetchPage = (
	cursorCreatedAt: number | null,
	cursorId: string | null,
): StaleRow[] => {
	const where =
		cursorCreatedAt != null && cursorId != null
			? `WHERE renderer_version < ${CURRENT_RENDERER_VERSION}
			   AND (created_at, id) > (${cursorCreatedAt}, '${sqlEsc(cursorId)}')`
			: `WHERE renderer_version < ${CURRENT_RENDERER_VERSION}`;
	const sql = `SELECT id, body_md, created_at FROM comments
	             ${where}
	             ORDER BY created_at ASC, id ASC
	             LIMIT ${PAGE_SIZE}`;
	const parsed = d1Json(sql) as
		| Array<{ results?: StaleRow[] }>
		| null;
	return parsed?.[0]?.results ?? [];
};

const updateOne = (id: string, body_html: string) => {
	const sql = `UPDATE comments
	             SET body_html = '${sqlEsc(body_html)}',
	                 renderer_version = ${CURRENT_RENDERER_VERSION}
	             WHERE id = '${sqlEsc(id)}'`;
	d1Json(sql);
};

const main = () => {
	console.log(
		`[rerender] target ${remoteFlag}, version → ${CURRENT_RENDERER_VERSION}`,
	);
	let cursorCreatedAt: number | null = null;
	let cursorId: string | null = null;
	let total = 0;
	while (true) {
		const rows = fetchPage(cursorCreatedAt, cursorId);
		if (rows.length === 0) break;
		for (const row of rows) {
			const html = renderMarkdown(row.body_md);
			updateOne(row.id, html);
			total++;
			cursorCreatedAt = row.created_at;
			cursorId = row.id;
		}
		console.log(`[rerender] processed ${total}`);
		if (rows.length < PAGE_SIZE) break;
	}
	console.log(`[rerender] done (${total} rendered)`);
};

try {
	main();
} catch (err) {
	console.error("[rerender] failed:", err);
	process.exit(1);
}
