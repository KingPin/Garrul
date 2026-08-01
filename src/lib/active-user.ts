/**
 * The one gate every state-changing public route runs a signed-in caller
 * through, so "banned" means the same thing everywhere.
 *
 * `is_banned` used to be consulted in four places — comment POST, login,
 * Telegram linking and admin access — which left PATCH/DELETE comment, votes,
 * reactions, reports, page engagement and subscribe open to a banned user for
 * as long as their cookie lasted.
 *
 * Bans also stamp a session revocation epoch (see `revokeUserSessions`), which
 * kills those cookies outright. This is the second layer: KV is eventually
 * consistent, so the stamp can take up to a minute to reach every colo, and
 * this check reads D1 — one indexed lookup by primary key on a path that is
 * already doing D1 work.
 */
import { getOrCreateGhost, getUser, type User } from "../db/queries";
import { readSession } from "./session";

type ActorCtx = {
	env: { DB: D1Database; SESSIONS: KVNamespace; ENV: string };
	req: { header(name: string): string | undefined };
	header(name: string, value: string, options?: { append?: boolean }): void;
};

/**
 * The user behind a session id, or null if they're banned or gone.
 *
 * Returning null for a deleted user matters as much as for a banned one: a
 * session outliving its row would otherwise attribute writes to a dangling id.
 */
export const requireActiveUser = async (
	db: D1Database,
	userId: string,
): Promise<User | null> => {
	const user = await getUser(db, userId);
	if (!user || user.is_banned) return null;
	return user;
};

/**
 * Resolve the identity to attribute a state-changing request to: the session
 * user, else the ip_hash ghost that lets an anonymous visitor's repeat clicks
 * toggle the same row.
 *
 * A banned session is rejected rather than quietly downgraded to its ghost —
 * falling back would hand them the anonymous budget and let the ban be shrugged
 * off by signing out.
 */
export const resolveActor = async (
	c: ActorCtx,
	ipHash: string,
): Promise<{ ok: true; userId: string } | { ok: false }> => {
	const session = await readSession(c);
	if (session) {
		const user = await requireActiveUser(c.env.DB, session.user_id);
		return user ? { ok: true, userId: user.id } : { ok: false };
	}
	const ghost = await getOrCreateGhost(c.env.DB, ipHash, "anon");
	return { ok: true, userId: ghost.id };
};
