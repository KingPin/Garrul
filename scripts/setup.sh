#!/usr/bin/env bash
# Garrul setup — prompt-driven first-time configuration.
# Creates D1 + KV namespaces, writes their IDs into wrangler.toml, and
# prompts for production secrets via `wrangler secret put`.
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
	read -r -p "wrangler.toml already exists. Overwrite? [y/N] " resp
	case "$resp" in
		y|Y|yes|YES) ;;
		*) echo "aborted."; exit 0 ;;
	esac
fi

cp wrangler.example.toml wrangler.toml
echo "✓ copied wrangler.example.toml → wrangler.toml"

confirm_route() {
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
	out=$(wrangler d1 create garrul-db 2>&1 || true)
	echo "$out"
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
	out=$(wrangler kv namespace create "$binding" 2>&1 || true)
	echo "$out"
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

echo
echo "=== Production secrets ==="
echo "These prompt one at a time. Skip any you don't have yet."

put_secret JWT_SECRET            "random 32+ char string for cookie signing"
put_secret IP_HASH_SECRET        "random 32+ char pepper for BLAKE3 IP hashing"
put_secret TURNSTILE_SITE_KEY    "from dash.cloudflare.com → Turnstile"
put_secret TURNSTILE_SECRET      "from dash.cloudflare.com → Turnstile"
put_secret GH_CLIENT_ID          "from github.com/settings/developers"
put_secret GH_CLIENT_SECRET      "from github.com/settings/developers"
put_secret GOOGLE_CLIENT_ID      "from console.cloud.google.com → OAuth credentials"
put_secret GOOGLE_CLIENT_SECRET  "from console.cloud.google.com → OAuth credentials"
put_secret RESEND_API_KEY        "from resend.com/api-keys"
put_secret WEBHOOK_URL           "optional fire-and-forget POST on new comment"

echo
echo "=== Next steps ==="
echo "1. Edit wrangler.toml: ALLOWED_ORIGINS, ADMIN_EMAILS, route pattern."
echo "2. Apply schema:  npm run migrate -- --remote"
echo "3. Deploy:        npm run deploy"
echo "4. Tail logs:     npm run tail"
