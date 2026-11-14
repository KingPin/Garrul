import type { User } from "../../db/queries";

// `adminViaDiscordRole` marks an admin whose authority came from a Discord
// role rather than their Garrul `users.role`; the ban-target guard keys on it.
export type OpActor = {
	user: User;
	role: "mod" | "admin";
	adminViaDiscordRole: boolean;
};

export type ActorRefusal = "not_linked" | "not_authorized" | "banned" | "wrong_guild";
