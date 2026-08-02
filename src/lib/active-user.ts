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
import {
	getGhostByIpHash,
	getOrCreateGhost,
	getUser,
	type User,
} from "../db/queries";
import { readSession } from "./session";

type ActorCtx = {
	env: { DB: D1Database; SESSIONS: KVNamespace; ENV: string };
	req: { header(name: string): string | undefined };
	header(name: string, value: string, options?: { append?: boolean }): void;
};

/**
 * The user behind a session id, or null if they're banned, erased or gone.
 *
 * Returning null for a deleted user matters as much as for a banned one: a
 * session outliving its row would otherwise attribute writes to a dangling id.
 *
 * `erased_at` is the same story as `is_banned`. `eraseUser` revokes their
 * sessions, but that stamp lives in KV and takes up to a minute to reach every
 * colo — and unlike a ban, the row it leaves behind is an emptied identity, so
 * a write landing inside that window attributes to a user whose name is now a
 * placeholder. This is the D1-backed layer that closes the window immediately.
 */
export const requireActiveUser = async (
	db: D1Database,
	userId: string,
): Promise<User | null> => {
	const user = await getUser(db, userId);
	if (!user || !isActiveUser(user)) return null;
	return user;
};

/**
 * Whether an already-loaded row may act — the predicate behind
 * `requireActiveUser`, split out for the one caller that can't use the async
 * wrapper: comment POST distinguishes "this session points at a row that no
 * longer exists" (401, refresh and sign in again) from "this user is refused"
 * (403), which a single null return can't express. It reads the same two
 * columns so the two paths can't drift.
 */
export const isActiveUser = (user: User): boolean =>
	!user.is_banned && user.erased_at === null;

/**
 * Resolve the identity to attribute a state-changing request to: the session
 * user, else the ip_hash ghost that lets an anonymous visitor's repeat clicks
 * toggle the same row.
 *
 * A banned session is rejected rather than quietly downgraded to its ghost —
 * falling back would hand them the anonymous budget and let the ban be shrugged
 * off by signing out.
 *
 * The ghost itself is checked for the mirror-image reason. `is_banned` is a
 * column on `users` and a ghost *is* a user row, so an operator banning an
 * abusive anonymous author from the admin queue expects that to stick; without
 * this the ban only reached comment POST (which checks the row it creates) and
 * votes, reactions and page engagement stayed open to them.
 *
 * It runs the whole `isActiveUser` predicate and not just `is_banned`, even
 * though an erased ghost is currently unreachable: `eraseUserData` nulls
 * `provider_id`, and the ghost lookup keys on `provider = 'anon' AND
 * provider_id = ?`, so erasing a ghost orphans the row and the next request
 * mints a fresh one. That is a property of the erase statement, not of this
 * gate. Checking both columns costs nothing here and means a future change to
 * that statement — preserving `provider_id` to keep an audit trail, say —
 * can't silently reopen the write window `isActiveUser` exists to close.
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
	if (!isActiveUser(ghost)) return { ok: false };
	return { ok: true, userId: ghost.id };
};

/**
 * Whether this ip_hash's anonymous identity is refused — without minting one.
 *
 * For the routes that accept an anonymous caller but never attribute the write
 * to a ghost. Reporting is the case: it stores `reporter_user_id = NULL` and
 * keys its dedup on the ip_hash instead, so `resolveActor` is the wrong tool —
 * it would create a user row per anonymous reporter, a D1 write on an
 * unauthenticated path for an identity nothing goes on to read.
 *
 * Named for the predicate rather than for the ban, because it is the same
 * `isActiveUser` gate as everywhere else — see `resolveActor` on why the erased
 * half is unreachable today and checked anyway.
 *
 * No row means nothing to refuse: an ip_hash that has never posted has no
 * identity to have banned, so this is `false` and the caller carries on.
 */
export const isInactiveGhost = async (
	db: D1Database,
	ipHash: string,
): Promise<boolean> => {
	const ghost = await getGhostByIpHash(db, ipHash);
	return ghost !== null && !isActiveUser(ghost);
};
