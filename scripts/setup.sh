#!/usr/bin/env bash
# Garrul setup — prompt-driven first-time configuration.
# Creates D1 + KV namespaces, writes their IDs into wrangler.toml (matched by
# binding name, so a reordered or hand-edited file is safe), and sets production
# secrets — either in bulk from secrets.env or one prompt at a time.
#
# Every config list below is generated between BEGIN/END markers — the secret
# prompts and the next-steps vars from scripts/config-registry.ts, the create_d1
# and create_kv calls from the Bindings type in src/index.ts. Run
# `npm run config:build` after editing either; `npm run config:check` fails CI
# when they drift.
#
# Run from repo root:  ./scripts/setup.sh

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f wrangler.example.toml ]; then
	echo "error: wrangler.example.toml missing — run from repo root." >&2
	exit 1
fi

if ! command -v wrangler >/dev/null 2>&1; then
	echo "error: wrangler not installed. Run 'npm install' first." >&2
	exit 1
fi

if [ -f wrangler.toml ]; then
	echo "✓ found existing wrangler.toml — keeping your edits"
	echo "  (D1/KV creation and secret prompts are idempotent and safe to re-run)"
else
	cp wrangler.example.toml wrangler.toml
	echo "✓ copied wrangler.example.toml → wrangler.toml"
fi

confirm_route() {
	# If the [[routes]] block is no longer fully commented out, assume the
	# user has configured (or deliberately removed) it and skip the prompt.
	if ! grep -qE '^[[:space:]]*#[[:space:]]*routes[[:space:]]*=' wrangler.toml; then
		echo
		echo "✓ routes section appears configured — skipping prompt"
		return
	fi
	# Never exits. D1, KV and the secret prompts below are identical either way,
	# so ejecting here only meant the operator hand-edited a 261-line TOML and
	# then re-ran everything — a rejection as the first thing the tool does.
	cat <<-'EOS'

		Where should this Worker answer requests?

		  1) *.workers.dev — free, live in minutes, no DNS to move. Good for
		     trying Garrul out. Not a production answer: the cross-site cookie
		     the embed needs gets blocked for some Safari/Firefox readers, so
		     sign-in breaks for them. Anonymous commenting still works.

		  2) A custom subdomain (comments.yourdomain.com) — the production
		     answer. Needs the domain on Cloudflare, and one edit to the
		     [[routes]] block in wrangler.toml.

		Either way the rest of this setup is the same, and moving from 1 to 2
		later is a config edit and a redeploy — no data migration.

	EOS
	read -r -p "Choose [1/2] (default 1): " resp
	case "$resp" in
		2)
			echo
			echo "→ Uncomment the [[routes]] block in wrangler.toml and set your"
			echo "  pattern, e.g. { pattern = \"comments.yourdomain.com\", custom_domain = true }"
			echo "  Do it before your first deploy; setup continues either way."
			;;
		*)
			echo
			echo "✓ staying on *.workers.dev — leave [[routes]] commented out."
			echo "  After your first deploy, set PUBLIC_BASE_URL, OAUTH_CALLBACK_BASE"
			echo "  and ALLOWED_ORIGINS to the workers.dev URL wrangler prints."
			;;
	esac
}
confirm_route

# Write an id into the wrangler.toml block that declares this binding — not
# into the first remaining placeholder in the file.
#
#   set_binding_id <table> <binding> <key> <placeholder> <id>
#
# The positional version substituted `0,/PLACEHOLDER/`, so correctness depended
# on the block order in wrangler.toml matching the create_kv call order below.
# setup.sh deliberately keeps an existing wrangler.toml, so an operator who had
# reordered their own blocks and re-ran setup got every id assigned to the wrong
# binding — silently. Setup succeeded and the Worker then read sessions out of
# the rate-limit namespace.
#
# awk rather than `sed -i`, which is a GNU extension: on macOS/BSD `sed -i`
# takes the backup suffix as its next argument and dies with "invalid command
# code" — the D1 substitution used to fail there.
#
# Exit codes from the awk pass, so a quiet re-run and a real problem read
# differently: 0 substituted, 3 the block already carries a real id, 4 no such
# block, 5 the block exists but declares no `key` at all. 1/2 are awk's own
# failures — deliberately not reused.
#
# 3 and 5 are split because collapsing them is how the old positional version
# read: a block with no `id` line is not a finished install, it is a config
# wrangler will reject at deploy, and reporting it with a ✓ buries that.
set_binding_id() {
	local table="$1" binding="$2" key="$3" ph="$4" id="$5" tmp rc
	# Alongside wrangler.toml, not in TMPDIR, so the swap below is a
	# same-filesystem rename rather than a copy.
	tmp=$(mktemp ./wrangler.toml.new.XXXXXX)
	# Seed it from the original so it inherits the mode; awk's redirect
	# truncates without changing it. Ownership is not preservable for a file the
	# operator does not own, and does not need to be — only the mode does.
	cp -p wrangler.toml "$tmp" 2>/dev/null || cp wrangler.toml "$tmp"
	set +e
	awk -v table="$table" -v binding="$binding" -v key="$key" -v ph="$ph" \
		-v newid="$id" '
		function emit() {
			if (!nblk) return
			if (istgt) {
				found = 1
				for (i = 1; i <= nblk; i++) {
					if (blk[i] ~ keyre) haskey = 1
					# Always writes the double-quoted form, so a single-quoted
					# placeholder is normalized to match the rest of the template.
					if (blk[i] ~ idre) { sub(phre, "\"" newid "\"", blk[i]); hit = 1 }
				}
			}
			for (i = 1; i <= nblk; i++) print blk[i]
			nblk = 0; istgt = 0
		}
		BEGIN {
			# Either TOML quote style. ASCII 39 is the apostrophe, spelled with
			# sprintf because a literal one would close the shell quoting that
			# wraps this whole program.
			q      = "[\"" sprintf("%c", 39) "]"
			# An optional dotted prefix matches wranglers per-environment
			# overrides, [[env.production.kv_namespaces]], which redeclare every
			# binding. The prefix must end in a dot, so [[foo_kv_namespaces]]
			# stays unmatched.
			hdrre  = "^[[:space:]]*\\[\\[([A-Za-z0-9_.-]+\\.)?" table "\\]\\]"
			bindre = "^[[:space:]]*binding[[:space:]]*=[[:space:]]*" q binding q
			phre   = q ph q
			# Anchored on the key, so `id` never matches `database_id`.
			keyre  = "^[[:space:]]*" key "[[:space:]]*="
			idre   = keyre "[[:space:]]*" phre
		}
		# Any table header closes the block being buffered.
		/^[[:space:]]*\[/ {
			emit()
			if ($0 ~ hdrre) { blk[++nblk] = $0; next }
			print; next
		}
		nblk > 0 {
			blk[++nblk] = $0
			# Buffered, so the binding line may follow the id line.
			if ($0 ~ bindre) istgt = 1
			next
		}
		{ print }
		END { emit(); exit hit ? 0 : (found ? (haskey ? 3 : 5) : 4) }
	' wrangler.toml > "$tmp"
	rc=$?
	set -e
	case $rc in
		0)
			# Atomic rename, so an interrupt or a full disk during the swap leaves
			# the operator's wrangler.toml intact rather than truncated. `cat >`
			# would have been a visible window with no backup to fall back on.
			mv "$tmp" wrangler.toml
			echo "✓ wrote $binding id $id into wrangler.toml" ;;
		3) echo "✓ $binding already has an id — leaving wrangler.toml alone" ;;
		4)
			echo "warning: no [[$table]] block binding $binding in wrangler.toml." >&2
			echo "         Add one by hand with $key = \"$id\"." >&2 ;;
		5)
			echo "warning: the [[$table]] block binding $binding declares no $key." >&2
			echo "         wrangler will reject the deploy — add $key = \"$id\" to it." >&2 ;;
		*)
			echo "error: awk failed (exit $rc) setting $binding; wrangler.toml unchanged." >&2
			echo "       Set $key = \"$id\" for $binding by hand." >&2 ;;
	esac
	rm -f "$tmp"
}

set_kv_id() {
	set_binding_id kv_namespaces "$1" id PASTE_FROM_WRANGLER_KV_CREATE "$2"
}

set_d1_id() {
	set_binding_id d1_databases "$1" database_id PASTE_FROM_WRANGLER_D1_CREATE "$2"
}

# create_d1 <binding> <database_name>
create_d1() {
	local binding="$1" name="$2"
	echo
	echo "Creating D1 database '$name'..."
	set +e
	out=$(wrangler d1 create "$name" 2>&1)
	rc=$?
	set -e
	echo "$out"
	if [ $rc -ne 0 ] && ! echo "$out" | grep -qE 'already exists|D1_ERROR.*name'; then
		echo "error: wrangler d1 create failed (exit $rc). Fix the above and re-run." >&2
		exit $rc
	fi
	id=$(echo "$out" | grep -Eo 'database_id = "[a-f0-9-]+"' | head -1 | sed 's/database_id = "//;s/"//')
	if [ -z "$id" ]; then
		echo "warning: could not auto-extract database_id for $binding; copy it into wrangler.toml manually." >&2
		return
	fi
	set_d1_id "$binding" "$id"
}

create_kv() {
	local binding="$1"
	echo
	echo "Creating KV namespace '$binding'..."
	set +e
	out=$(wrangler kv namespace create "$binding" 2>&1)
	rc=$?
	set -e
	echo "$out"
	if [ $rc -ne 0 ] && ! echo "$out" | grep -q 'already exists'; then
		echo "error: wrangler kv namespace create $binding failed (exit $rc). Fix the above and re-run." >&2
		exit $rc
	fi
	id=$(echo "$out" | grep -Eo 'id = "[a-f0-9]+"' | head -1 | sed 's/id = "//;s/"//')
	if [ -z "$id" ]; then
		echo "warning: could not auto-extract id for $binding; copy manually." >&2
		return
	fi
	set_kv_id "$binding" "$id"
}

# BEGIN:d1-bindings
# Generated by `npm run config:build` from the Bindings type in src/index.ts. Do not edit by hand.
create_d1 DB garrul-db
# END:d1-bindings
# BEGIN:kv-bindings
# Generated by `npm run config:build` from the Bindings type in src/index.ts. Do not edit by hand.
create_kv RATE_LIMITS
create_kv OAUTH_STATE
create_kv SESSIONS
create_kv TREE_CACHE
# END:kv-bindings

put_secret() {
	local name="$1"
	local hint="$2"
	echo
	read -r -p "Set $name? ($hint) [y/N] " resp
	case "$resp" in
		y|Y|yes|YES) wrangler secret put "$name" ;;
		*) echo "  skipped — set later with: wrangler secret put $name" ;;
	esac
}

# Prompt once for a provider; if accepted, set both paired secrets.
# Otherwise skip the whole group so users aren't asked twice to say no.
put_secret_pair() {
	local label="$1"
	local hint="$2"
	local name_a="$3"
	local name_b="$4"
	echo
	read -r -p "Configure $label? ($hint) [y/N] " resp
	case "$resp" in
		y|Y|yes|YES)
			wrangler secret put "$name_a"
			wrangler secret put "$name_b"
			;;
		*)
			echo "  skipped — set later with:"
			echo "    wrangler secret put $name_a"
			echo "    wrangler secret put $name_b"
			;;
	esac
}

# Auto-generate a 32-byte base64 random secret and stream it to wrangler.
# Falls back to interactive entry if openssl is unavailable.
put_random_secret() {
	local name="$1"
	local hint="$2"
	if ! command -v openssl >/dev/null 2>&1; then
		put_secret "$name" "$hint"
		return
	fi
	echo
	read -r -p "Auto-generate $name? ($hint) [Y/n] " resp
	case "$resp" in
		n|N|no|NO) echo "  skipped — set later with: wrangler secret put $name" ;;
		*)
			openssl rand -base64 32 | wrangler secret put "$name"
			echo "  ✓ generated and stored (never written to disk)"
			;;
	esac
}

# One prompt per secret — the original path. The call list is generated from
# scripts/config-registry.ts so a newly added secret can't go unprompted.
interactive_secrets() {
	echo
	echo "One prompt per secret. Skip any you don't have yet."
# BEGIN:interactive-secrets
	# Generated by `npm run config:build` from scripts/config-registry.ts. Do not edit by hand.
	put_secret_pair "Turnstile" "from dash.cloudflare.com → Turnstile" TURNSTILE_SITE_KEY TURNSTILE_SECRET
	put_secret_pair "GitHub OAuth" "from github.com/settings/developers" GH_CLIENT_ID GH_CLIENT_SECRET
	put_secret_pair "Google OAuth" "from console.cloud.google.com → OAuth credentials" GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
	put_secret_pair "Facebook OAuth" "from developers.facebook.com → Facebook Login" FACEBOOK_CLIENT_ID FACEBOOK_CLIENT_SECRET
	put_secret_pair "X/Twitter OAuth" "from developer.x.com → OAuth 2.0 (returns no email)" TWITTER_CLIENT_ID TWITTER_CLIENT_SECRET
	put_secret_pair "Discord OAuth" "from discord.com/developers → OAuth2" DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET
	put_secret RESEND_API_KEY "from resend.com/api-keys"
	put_secret WEBHOOK_URL "legacy single-URL webhook; prefer /admin/webhooks endpoints"
	put_secret TELEGRAM_BOT_TOKEN "BotFather token; see docs/telegram.md"
	put_secret TELEGRAM_WEBHOOK_SECRET "shared secret for setWebhook; required for inbound commands"
	put_secret AKISMET_API_KEY "required when SPAM_PROVIDER = \"akismet\""
	put_secret AKISMET_SITE_URL "public site URL registered with Akismet"
	put_secret SPAM_FORM_TS_SECRET "HMAC key for signed form-timestamp tokens"
	put_secret CF_API_TOKEN "Analytics-read token; scopes in AGENTS-OPERATE §5"
	put_secret GITHUB_TOKEN "read-only public_repo token; raises the 60 req/hr cap"
# END:interactive-secrets
}

SECRETS_FILE=secrets.env

# Fill one file, upload every secret in a single `wrangler secret bulk` call.
bulk_secrets() {
	# 0600, not the umask default: this file is about to hold the Resend key,
	# five OAuth client secrets, CF_API_TOKEN, TELEGRAM_BOT_TOKEN and
	# AKISMET_API_KEY in plaintext. `install -m` sets the mode as it copies, so
	# there is no window where the file exists world-readable. The warning below
	# already tells operators it's plaintext on disk — make the bits agree.
	if [ -f "$SECRETS_FILE" ]; then
		chmod 600 "$SECRETS_FILE"
		echo "✓ found existing $SECRETS_FILE — using it as-is (mode 600)"
	else
		install -m 600 secrets.example.env "$SECRETS_FILE"
		echo "✓ copied secrets.example.env → $SECRETS_FILE (mode 600)"
	fi

	echo
	echo "Edit $SECRETS_FILE: uncomment and fill in the secrets you have."
	echo "LEAVE THE REST COMMENTED. wrangler treats an empty value as a real,"
	echo "empty secret — an uncommented 'RESEND_API_KEY=' overwrites your live"
	echo "key with nothing rather than skipping it."
	echo
	echo "WARNING: $SECRETS_FILE holds plaintext credentials on disk. It is"
	echo "gitignored, but delete it once the upload succeeds."

	if [ -n "${EDITOR:-}" ]; then
		echo
		read -r -p "Open $SECRETS_FILE in \$EDITOR ($EDITOR)? [Y/n] " resp
		case "$resp" in
			n|N|no|NO) ;;
			*) "$EDITOR" "$SECRETS_FILE" ;;
		esac
	fi

	echo
	read -r -p "Press enter when $SECRETS_FILE is ready (Ctrl-C to abort) " _

	echo
	set +e
	wrangler secret bulk "$SECRETS_FILE"
	rc=$?
	set -e
	if [ $rc -ne 0 ]; then
		echo
		echo "error: wrangler secret bulk failed (exit $rc)." >&2
		echo "  'is not valid' means every line is still commented out — nothing" >&2
		echo "  was uploaded. Uncomment the secrets you want and re-run." >&2
		echo "$SECRETS_FILE was left in place." >&2
		exit $rc
	fi

	echo
	read -r -p "Upload succeeded. Delete $SECRETS_FILE now? [Y/n] " resp
	case "$resp" in
		n|N|no|NO) echo "  kept — it still holds plaintext credentials" ;;
		*) rm -f "$SECRETS_FILE"; echo "  ✓ deleted" ;;
	esac
}

echo
echo "=== Production secrets ==="
echo
echo "JWT_SECRET and IP_HASH_SECRET are generated here and streamed straight"
echo "into wrangler — the values never touch disk."

# BEGIN:generated-secrets
# Generated by `npm run config:build` from scripts/config-registry.ts. Do not edit by hand.
put_random_secret JWT_SECRET "auto-generated 32-byte HMAC key for signed OAuth state"
put_random_secret IP_HASH_SECRET "auto-generated HMAC pepper — generate once and keep it"
# END:generated-secrets

echo
echo "The remaining secrets can be set two ways:"
echo "  b) bulk   — fill in one file, upload them all in a single call"
echo "  p) prompt — answer one question per secret"
echo
read -r -p "Which? [b/P] " mode
case "$mode" in
	b|B|bulk|BULK) bulk_secrets ;;
	*) interactive_secrets ;;
esac

echo
echo "=== Next steps ==="
# BEGIN:must-edit-vars
# Generated by `npm run config:build` from scripts/config-registry.ts. Do not edit by hand.
echo "1. Edit wrangler.toml before deploying — these ship as placeholders:"
echo "     ALLOWED_ORIGINS     — comma-separated origins allowed to embed and call /api/*"
echo "     ADMIN_EMAILS        — comma-separated emails that get auto-admin on OAuth signup"
echo "     PUBLIC_BASE_URL     — public URL of this Worker; used in permalinks and email bodies"
echo "     OAUTH_CALLBACK_BASE — must match the redirect URI registered with each provider"
echo "   Plus the [[routes]] pattern, if you skipped it above."
# END:must-edit-vars
echo "2. Apply schema:  npm run migrate -- --remote"
echo "3. Deploy:        npm run deploy"
echo "4. Tail logs:     npm run tail"
