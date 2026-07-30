#!/usr/bin/env bash
# Garrul setup — prompt-driven first-time configuration.
# Creates D1 + KV namespaces, writes their IDs into wrangler.toml, and sets
# production secrets — either in bulk from secrets.env or one prompt at a time.
#
# The secret call lists are generated from scripts/config-registry.ts between
# BEGIN/END markers. Run `npm run config:build` after editing the registry;
# `npm run config:check` fails CI when they drift.
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
	echo
	echo "RECOMMENDATION: use a custom subdomain (e.g. comments.yourdomain.com)"
	echo "for the Worker route. *.workers.dev subdomains cause third-party-cookie"
	echo "friction in some browsers and break the embed for Safari/Firefox users."
	echo
	read -r -p "Continue without configuring a custom route? [y/N] " resp
	case "$resp" in
		y|Y|yes|YES) ;;
		*)
			echo "Edit wrangler.toml's [[routes]] section, then re-run."
			exit 0 ;;
	esac
}
confirm_route

create_d1() {
	echo
	echo "Creating D1 database 'garrul-db'..."
	set +e
	out=$(wrangler d1 create garrul-db 2>&1)
	rc=$?
	set -e
	echo "$out"
	if [ $rc -ne 0 ] && ! echo "$out" | grep -qE 'already exists|D1_ERROR.*name'; then
		echo "error: wrangler d1 create failed (exit $rc). Fix the above and re-run." >&2
		exit $rc
	fi
	id=$(echo "$out" | grep -Eo 'database_id = "[a-f0-9-]+"' | head -1 | sed 's/database_id = "//;s/"//')
	if [ -z "$id" ]; then
		echo "warning: could not auto-extract database_id; copy it into wrangler.toml manually." >&2
		return
	fi
	# Substitute the placeholder in wrangler.toml.
	sed -i "s/PASTE_FROM_WRANGLER_D1_CREATE/$id/" wrangler.toml
	echo "✓ wrote D1 id $id into wrangler.toml"
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
	# Replace the first remaining placeholder. KV bindings appear in
	# the order RATE_LIMITS, OAUTH_STATE, SESSIONS, TREE_CACHE in the
	# template; we substitute in that order.
	sed -i "0,/PASTE_FROM_WRANGLER_KV_CREATE/{s/PASTE_FROM_WRANGLER_KV_CREATE/$id/}" wrangler.toml
	echo "✓ wrote $binding id $id into wrangler.toml"
}

create_d1
create_kv RATE_LIMITS
create_kv OAUTH_STATE
create_kv SESSIONS
create_kv TREE_CACHE

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
	if [ -f "$SECRETS_FILE" ]; then
		echo "✓ found existing $SECRETS_FILE — using it as-is"
	else
		cp secrets.example.env "$SECRETS_FILE"
		echo "✓ copied secrets.example.env → $SECRETS_FILE"
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
put_random_secret JWT_SECRET "auto-generated 32-byte secret; reserved for future JWT use"
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
echo "1. Edit wrangler.toml: ALLOWED_ORIGINS, ADMIN_EMAILS, route pattern."
echo "2. Apply schema:  npm run migrate -- --remote"
echo "3. Deploy:        npm run deploy"
echo "4. Tail logs:     npm run tail"
