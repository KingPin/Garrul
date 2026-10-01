/**
 * `npm run owner-link [-- --local] [-- --base-url https://host]`
 *
 * Prints a single-use, 10-minute sign-in link for the ONE owner identity
 * (users.provider = 'owner'). Your Cloudflare login (wrangler) authorizes
 * creating it; the token proves possession when the link is opened.
 *
 * Output contract: stdout is ONLY the link. Every other message goes to
 * stderr. The token is never written to a file; only its SHA-256 reaches D1
 * (and so wrangler's argv), never the token itself.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	OWNER_PROVIDER,
	OWNER_PROVIDER_ID,
	OWNER_TOKEN_TTL_MS,
	hashOwnerToken,
} from "../src/lib/owner-login";
import { ulid } from "../src/lib/ulid";
import { parseTomlVars } from "./upgrade/toml-vars";

export const PLACEHOLDER_BASE_URL = "https://comments.example.com";

export class RefuseError extends Error {}

type OwnerRow = {
	id: string;
	provider_id: string | null;
	is_admin: number;
	is_banned: number;
	role: string;
	erased_at: number | null;
};

export const OWNER_ROWS_SQL = `SELECT id, provider_id, is_admin, is_banned, role, erased_at FROM users WHERE provider = '${OWNER_PROVIDER}'`;

/**
 * Decide what to do from every provider='owner' row. Looks at the provider
 * alone (not provider_id): erasure NULLs provider_id, and matching on the pair
 * would then mint a second owner next to the erased one.
 */
export const classifyOwnerRows = (
	rows: OwnerRow[],
): { kind: "none" } | { kind: "ok"; id: string } => {
	if (rows.length === 0) return { kind: "none" };
	const r = rows[0] as OwnerRow;
	if (rows.length > 1) {
		throw new RefuseError("More than one owner row exists. Resolve it by hand.");
	}
	if (r.erased_at !== null || r.provider_id !== OWNER_PROVIDER_ID) {
		throw new RefuseError("The owner account was erased. Recovery is a manual step.");
	}
	if (r.is_banned) {
		throw new RefuseError("The owner account is banned. Unban it in the admin UI or D1 first.");
	}
	if (r.role !== "admin" || !r.is_admin) {
		throw new RefuseError("The owner account was demoted. Restore its admin role by hand first.");
	}
	if (!/^[0-9A-Z]{26}$/.test(r.id)) {
		throw new RefuseError("The owner row has an unexpected id.");
	}
	return { kind: "ok", id: r.id };
};

export const insertOwnerSql = (id: string, now: number): string => {
	if (!/^[0-9A-Z]{26}$/.test(id)) throw new Error("bad owner id");
	return `INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at) VALUES ('${id}', '${OWNER_PROVIDER}', '${OWNER_PROVIDER_ID}', 'Owner', 1, 'admin', ${Math.trunc(now)}) ON CONFLICT(provider, provider_id) DO NOTHING`;
};

export const clearOldTokensSql = (userId: string, now: number): string => {
	if (!/^[0-9A-Z]{26}$/.test(userId)) throw new Error("bad owner id");
	return `DELETE FROM owner_login_tokens WHERE user_id = '${userId}' AND (used_at IS NULL OR expires_at < ${Math.trunc(now)})`;
};

export const insertTokenSql = (
	userId: string,
	tokenHash: string,
	now: number,
): string => {
	if (!/^[0-9A-Z]{26}$/.test(userId)) throw new Error("bad owner id");
	if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error("bad token hash");
	return `INSERT INTO owner_login_tokens (token_hash, user_id, expires_at) VALUES ('${tokenHash}', '${userId}', ${Math.trunc(now + OWNER_TOKEN_TTL_MS)})`;
};

export const newToken = (): string =>
	Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export const resolveBaseUrl = (
	toml: string,
	override: string | undefined,
	local: boolean,
): string => {
	const raw = (override ?? parseTomlVars(toml).PUBLIC_BASE_URL ?? "").trim();
	if (!raw || raw === PLACEHOLDER_BASE_URL) {
		throw new RefuseError(
			"PUBLIC_BASE_URL is empty or still the placeholder in wrangler.toml. Set it, or pass --base-url.",
		);
	}
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new RefuseError(`PUBLIC_BASE_URL is not a valid URL: ${raw}`);
	}
	if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
		throw new RefuseError("The base URL must be https (http only with --local).");
	}
	return u.origin;
};

export const databaseName = (toml: string): string => {
	const m = /\[\[d1_databases\]\][\s\S]*?database_name\s*=\s*"([^"]+)"/.exec(toml);
	if (!m) throw new RefuseError("No [[d1_databases]] database_name in wrangler.toml.");
	return m[1] as string;
};

const d1 = (db: string, local: boolean, sql: string): unknown[] => {
	const r = spawnSync(
		"npx",
		["wrangler", "d1", "execute", db, local ? "--local" : "--remote", "--json", "--command", sql],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (r.error) throw r.error;
	if (r.status !== 0) {
		throw new Error(`wrangler d1 execute failed (${r.status}): ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
	}
	const parsed = JSON.parse(r.stdout) as Array<{ results?: unknown[] }>;
	return parsed[0]?.results ?? [];
};

const main = async (): Promise<void> => {
	const argv = process.argv.slice(2);
	const local = argv.includes("--local");
	const bi = argv.indexOf("--base-url");
	const override = bi >= 0 ? argv[bi + 1] : undefined;
	try {
		const tomlPath = join(process.cwd(), "wrangler.toml");
		if (!existsSync(tomlPath)) {
			throw new RefuseError("wrangler.toml not found. Run npm run setup first.");
		}
		const toml = readFileSync(tomlPath, "utf8");
		const base = resolveBaseUrl(toml, override, local);
		const db = databaseName(toml);

		const read = () => classifyOwnerRows(d1(db, local, OWNER_ROWS_SQL) as OwnerRow[]);
		let state = read();
		if (state.kind === "none") {
			d1(db, local, insertOwnerSql(ulid(), Date.now()));
			state = read();
		}
		if (state.kind !== "ok") throw new Error("Could not create the owner row.");

		const token = newToken();
		const now = Date.now();
		d1(db, local, clearOldTokensSql(state.id, now));
		d1(db, local, insertTokenSql(state.id, await hashOwnerToken(token), now));

		console.error("Owner sign-in link (valid 10 minutes, single use):");
		process.stdout.write(`${base}/admin/owner#t=${token}\n`);
	} catch (err) {
		console.error(`owner-link: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void main();
}
