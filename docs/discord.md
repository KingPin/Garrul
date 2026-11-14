# Discord operator bot

An optional Discord bot for **operators** (admins and mods) — not readers.
It does four things:

1. **Alerts** — comment events posted to a channel as embeds with action
   buttons: **Approve / Spam / Delete / Restore / Ban / Resolve reports /
   Reply**.
2. **On-the-spot moderation** — click a button to act without opening the admin
   panel. Every action runs through the same audited path as the dashboard.
3. **Slash commands** — `/queue`, `/stats`, `/comment`, `/user`, `/unban`,
   `/link`.
4. **Daily digest** — an optional once-daily summary posted to one channel.

It is a set of HTTPS interactions handled by the Worker. There is no gateway
(websocket) bot, no process outside the Worker, no DMs. Bot text is English-only.

The feature is **off** until both `DISCORD_BOT_TOKEN` and `DISCORD_PUBLIC_KEY`
are set. Telegram and Discord share one core (`src/lib/opbot/`), so the two
bots offer the same actions; see [telegram.md](./telegram.md) for the other
transport.

## 1. Set up the Discord application

You can reuse the application you created for Discord sign-in. Garrul reuses
`DISCORD_CLIENT_ID` as the application id, so one Discord app serves both.

1. Open the [Discord developer portal](https://discord.com/developers/applications)
   and create an application (or open your sign-in application).
2. On the **Bot** tab, add a bot and **Reset Token**. Copy the token. Treat it
   as a secret — it can post as your bot.
3. On **General Information**, copy the **Public Key** (64 hex characters).
4. Set the secret and the var:

   ```bash
   wrangler secret put DISCORD_BOT_TOKEN
   ```

   ```toml
   # wrangler.toml [vars] — the public key is public, not a secret
   DISCORD_PUBLIC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
   ```

   For local `wrangler dev`, the same names live in `.dev.vars`
   (see `.dev.vars.example`).
5. Deploy, then on **General Information** set **Interactions Endpoint URL** to
   `https://<your-worker>/discord/interactions` (the same URL is shown on
   `/admin/discord`). Discord sends a signed PING when you save; the Worker
   answers it, so the save fails until the secret, the key and the deploy are in
   place.
6. Invite the bot to your server (**OAuth2 → URL Generator**, scope `bot`). In
   each alert and digest channel the bot needs **View Channel**, **Send
   Messages** and **Embed Links**.

## 2. Configure the server

Open **`/admin/discord`** (admin only) and fill in:

| Setting | Purpose |
|---|---|
| Guild id | Only interactions from this server are accepted. Required. |
| Mod role id | Members with this role act as `mod`. |
| Admin role id | Optional. Members with this role act as `admin`. |
| Digest channel id | Optional. Channel for the daily digest. Empty = no Discord digest. |

Enable Developer Mode in Discord (User Settings → Advanced) to copy ids.
Settings go through the settings memo, so a change can lag up to 60 s.

Then click **Register commands**. Garrul overwrites the guild's slash commands
in one call; it takes effect at once.

## 3. Wire up alerts

Alerts reuse the webhook system (see [webhooks.md](./webhooks.md)). Add an
endpoint in **`/admin/webhooks`** with the **`discord_bot`** adapter and put the
**channel id** (not a URL) in the URL field. Add one endpoint per channel; each
has its own event filter.

Saving the endpoint calls Discord once to check the channel. The save fails
unless the channel exists, belongs to the configured guild, and is a text or
announcement channel. A good lookup does not prove the bot can send: if the bot
lacks permission, deliveries fail and go through the normal retry queue.

The existing `discord` incoming-webhook adapter stays available for alert-only
use. It cannot carry buttons.

Each alert carries buttons for the comment's **current** status (a pending
comment offers Approve / Spam, an approved one offers Spam, a spam-flagged one
offers Restore), plus Reply. After a click the same message edits itself to show
the result and who did it ("Approved by Alice") with the buttons for the new
status. Only the clicked message updates: if the comment is moderated
elsewhere, other alerts keep their old buttons.

## 4. Who may act

Two sources of authority. The higher role wins.

- **Linked account.** The actor's current Garrul role (`users.role`) is
  re-read on every action. See "Link an account".
- **Discord role.** A member holding the configured mod or admin role gets
  `mod` or `admin` for that interaction only. On a role-holder's first action
  Garrul creates a `users` row (`provider='discord'`, the Discord id, no email)
  so the audit log has an actor. The Discord role is **never** written to
  `users.role`; removing the Discord role revokes access on the next click.

Rules:

- A banned Garrul user is refused, whatever Discord role they hold.
- Interactions from another guild, or from a DM, are refused.
- **Ban** and **Unban** need `admin`. Everything else needs `mod`.
- A role-derived admin cannot ban or unban a user whose Garrul role is `mod`
  or `admin`. Only a real Garrul admin can.
- Role-only mods see **shared** saved replies only.

## 5. Link an account

Linking is optional for people with the mod or admin role. It gives a stable
identity (and the Garrul role) when someone should act as a specific Garrul user.

1. In **`/admin/discord`**, click **Generate link code** (admin only). The code
   is a one-time token with a 10-minute TTL.
2. In the configured server, run `/link <code>`. The reply is ephemeral.
3. Garrul writes a `discord_links` row (Discord user id to Garrul user id).

If a Garrul user already exists with `provider='discord'` and the clicker's
Discord id (they signed in with Discord), that counts as linked, with no code.
Unlink from the same page. A `discord_links` row wins over the sign-in row if
both exist.

## 6. Commands

All commands are guild commands and every reply is **ephemeral** (only the
person who ran it sees it).

| Command | Needs | Shows |
|---|---|---|
| `/queue` | mod | pending count, open reports, oldest pending, and a **Review** button |
| `/stats` | mod | totals and 7-day spam rate |
| `/comment <id>` | mod | a comment's status, author, snippet, open reports, with buttons |
| `/user <id>` | mod | role, ban state and reason, provider, join age |
| `/unban <id>` | admin | lifts a ban |
| `/link <code>` | anyone | links your Discord account |

**Review** walks pending comments **oldest first**, one card at a time, with the
action buttons and **Skip**. The walk keeps no server state; a comment someone
else moderated mid-walk does not break it.

**Ban** asks for a reason in a modal (the reason lands in the audit log). `/user`
reads the latest ban entry from the audit log: "Banned — <reason>", "Banned —
reason no longer available" if the audit row was purged, or "Not banned".

## 7. Replying and saved replies

**Reply** posts an operator reply to a comment, with the dashboard defaults
(`notify` on, posted as staff). The bot has no toggle for either.

1. Click **Reply**. An ephemeral picker lists your saved replies plus
   **Write custom**.
2. Pick one. A modal opens, pre-filled with the text (`{name}`, `{post}`,
   `{mod}` already expanded). Edit it, then submit.

Discord limits shape the picker:

- A menu holds 25 options. **Write custom** takes one; when more saved replies
  remain, **More…** takes another, so a page shows 23 replies (up to 24 on the
  last page).
- Titles over 100 characters are cut with "…". Only the title is cut.
- A modal holds 4000 characters. A saved reply whose expanded body is longer is
  left out, and the picker says to use the dashboard for those. The bot never
  posts a cut body.

Reply from an alert also refreshes the alert with the "done by" line. If that
edit fails, the reply stays posted and the failure is logged.

## 8. Daily digest (optional)

When the bot is on (token and public key) and a **Digest channel id** is set,
the existing `*/15` cron posts a once-daily summary (pending, open reports and
most-flagged thread, 7-day spam rate, oldest pending) to that channel. It
self-gates to roughly once every 24 hours using its own timestamp
(`dc_digest_last_sent_at`), independent of the Telegram digest. Because it goes
to a channel, role-only team mods see it too. A failed post is logged and
retried the next day.

## Security notes

- **Signature check first.** `POST /discord/interactions` verifies Ed25519 over
  `timestamp + body` with the application public key. A bad or missing
  signature is **401**, before any database or KV access. An unset
  `DISCORD_PUBLIC_KEY` rejects everything (fail closed).
- **Timestamp window.** A timestamp more than 5 minutes from the Worker clock is
  **401**, which blocks replay of a captured signed request later on.
- **Accepted risk.** There is no dedupe table. A replay inside the 5-minute
  window (or a Telegram redelivery) can post a reply twice. A repeated moderation
  action reaches the same end state and may add a second audit row. Only a reply
  adds a second comment.
- **Re-authorization on every step.** Each button, select and modal submit
  re-resolves the actor and re-checks the role.
- **No mentions.** Every message the bot sends sets
  `allowed_mentions: { parse: [] }`, so it cannot ping `@everyone`, `@here`, a
  user or a role. User text is also escaped.
- **Roles stay in Discord.** Discord roles never become `users.role`.
- The route is rate-limited per Discord user id.
- Token, ids and comment bodies are never logged. Actions write the same audit
  rows as the dashboard, attributed to the actor's user id.
- Personal data: `discord_links` holds a Discord user id. It is deleted on user
  erasure and included in the personal-data export.
- Cost: 0 new KV writes per interaction (a ban keeps its existing
  session-revocation write), and nothing is added to the widget bundle.
