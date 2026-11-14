import {
	getDiscordLinkByDiscordUser,
	getTelegramLinkByTgUser,
	getUser,
	getUserByProvider,
	upsertOauthUser,
	type User,
} from "../../db/queries";

// `adminViaDiscordRole` marks an admin whose authority came from a Discord
// role rather than their Garrul `users.role`; the ban-target guard keys on it.
export type OpActor = {
	user: User;
	role: "mod" | "admin";
	adminViaDiscordRole: boolean;
};

export type ActorRefusal = "not_linked" | "not_authorized" | "banned" | "wrong_guild";

export type DiscordAuthConfig = {
	guildId: string;
	modRoleId: string;
	adminRoleId: string;
};

type Resolution = { ok: true; actor: OpActor } | { ok: false; reason: ActorRefusal };

const RANK = { user: 0, mod: 1, admin: 2 } as const;
type Rank = keyof typeof RANK;

// An erased row is never an actor, even if a lookup still finds it.
const live = (u: User | null): User | null => (u && !u.erased_at ? u : null);

export const resolveTelegramActor = async (
	db: D1Database,
	tgUserId: string,
): Promise<Resolution> => {
	const link = await getTelegramLinkByTgUser(db, tgUserId);
	const user = link ? live(await getUser(db, link.user_id)) : null;
	if (!user) return { ok: false, reason: "not_linked" };
	if (user.is_banned) return { ok: false, reason: "banned" };
	if (user.role === "user") return { ok: false, reason: "not_authorized" };
	return { ok: true, actor: { user, role: user.role, adminViaDiscordRole: false } };
};

/**
 * Spec §2 identity precedence: discord_links user (A), else the
 * provider='discord' row (B), else a new role-holder row. Either candidate
 * being banned refuses the action; the core never falls back past a ban.
 */
export const resolveDiscordActor = async (
	db: D1Database,
	cfg: DiscordAuthConfig,
	i: { guildId?: string | undefined; discordUserId: string; displayName: string; roles?: string[] | undefined },
): Promise<Resolution> => {
	if (!i.guildId || i.guildId !== cfg.guildId) return { ok: false, reason: "wrong_guild" };

	const link = await getDiscordLinkByDiscordUser(db, i.discordUserId);
	const a = link ? live(await getUser(db, link.user_id)) : null;
	const b = live(await getUserByProvider(db, "discord", i.discordUserId));
	if (a?.is_banned || b?.is_banned) return { ok: false, reason: "banned" };

	const roles = i.roles ?? [];
	// An empty configured id never matches (unset role = feature off).
	const grant: Rank =
		cfg.adminRoleId && roles.includes(cfg.adminRoleId)
			? "admin"
			: cfg.modRoleId && roles.includes(cfg.modRoleId)
				? "mod"
				: "user";

	let user = a ?? b;
	if (!user) {
		if (grant === "user") return { ok: false, reason: "not_linked" };
		// Only here: upsertOauthUser's update branch would null an existing avatar.
		user = await upsertOauthUser(db, "discord", i.discordUserId, i.displayName, null, null, new Set());
		// Guard: erasure nulls provider_id, but never act as an erased row if one still holds the key.
		if (user.erased_at) return { ok: false, reason: "not_linked" };
	}

	const effective: Rank = RANK[grant] > RANK[user.role] ? grant : user.role;
	if (effective === "user") return { ok: false, reason: "not_authorized" };
	return {
		ok: true,
		actor: { user, role: effective, adminViaDiscordRole: effective === "admin" && user.role !== "admin" },
	};
};
