#!/usr/bin/env bash
# Garrul setup — prompt-driven install, from a fresh clone to a live Worker.
# Creates D1 + KV namespaces (reusing any of that name already in the account),
# writes their IDs into wrangler.toml (matched by binding name, so a reordered
# or hand-edited file is safe; a stale id from another account is replaced), sets production
# secrets (bulk from secrets.env or one prompt at a time), writes the
# placeholder [vars], then offers to migrate the remote D1, deploy, and check
# /api/v1/health. Every step after the secrets asks first; re-runs keep
# existing vars.
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
			echo "  Leave PUBLIC_BASE_URL and OAUTH_CALLBACK_BASE empty at the vars"
			echo "  prompt; after the deploy, setup offers to fill them from the"
			echo "  workers.dev URL wrangler prints."
			echo "  ALLOWED_ORIGINS stays the site that embeds the widget."
			;;
	esac
}
confirm_route

# A login that can see several Cloudflare accounts makes every wrangler call
# below stop and ask "Select an account" — a dozen times, and invisibly inside
# the id lookups that capture wrangler's output. Ask once, up front, and hand
# the answer to every call through CLOUDFLARE_ACCOUNT_ID. Skipped when the
# caller or wrangler.toml already pins an account.
select_account() {
	local json rows n i choice id name
	[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && return 0
	grep -qE '^[[:space:]]*account_id[[:space:]]*=' wrangler.toml && return 0
	if ! json=$(wrangler whoami --json 2>/dev/null); then
		echo
		echo "warning: could not read your Cloudflare login. If the next step fails, run: npx wrangler login" >&2
		return 0
	fi
	rows=$(printf '%s' "$json" | node -e '
		let s = "";
		process.stdin.on("data", (d) => { s += d; }).on("end", () => {
			try {
				for (const a of JSON.parse(s.slice(s.search(/^\{/m))).accounts ?? [])
					console.log(`${a.id}\t${a.name}`);
			} catch {}
		});
	' || true)
	n=$(printf '%s' "$rows" | grep -c . || true)
	[ "$n" -gt 0 ] || return 0
	if [ "$n" = 1 ]; then
		IFS=$'\t' read -r id name <<< "$rows"
		echo
		echo "✓ Cloudflare account: $name"
		export CLOUDFLARE_ACCOUNT_ID="$id"
		return 0
	fi
	echo
	echo "Your Cloudflare login can use $n accounts. Which one gets Garrul?"
	i=0
	while IFS=$'\t' read -r id name; do
		i=$((i + 1))
		echo "  $i) $name"
	done <<< "$rows"
	while :; do
		read -r -p "Choose [1-$n]: " choice
		case "$choice" in
			*[!0-9]*|"") ;;
			*) [ "$choice" -ge 1 ] && [ "$choice" -le "$n" ] && break ;;
		esac
		echo "  enter a number from 1 to $n"
	done
	IFS=$'\t' read -r id name <<< "$(printf '%s\n' "$rows" | sed -n "${choice}p")"
	echo "✓ using $name"
	export CLOUDFLARE_ACCOUNT_ID="$id"
}
select_account

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
			# Top-level tables only. Setup resolves resources for the default
			# environment, so [[env.<name>.kv_namespaces]] overrides belong to the
			# operator and stay untouched.
			hdrre  = "^[[:space:]]*\\[\\[" table "\\]\\]"
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

# Any quoted value, so set_binding_id overwrites a stale id as well as a
# placeholder. The ids in wrangler.toml are only as good as the account they
# came from: an existing file copied from another account carries ids that do
# not exist here, and the migrate step then fails with API error 7404.
ANY_VALUE='[^"'"'"']*'

set_kv_id() {
	set_binding_id kv_namespaces "$1" id "$ANY_VALUE" "$2"
}

set_d1_id() {
	set_binding_id d1_databases "$1" database_id "$ANY_VALUE" "$2"
}

# remote_id <d1|kv> <name-or-id> — id of the resource with that name or id in the logged-in
# account. Empty when there is none or the lookup failed; the caller then
# creates it, and wrangler reports a real auth error there.
remote_id() {
	local json
	case "$1" in
		d1) json=$(wrangler d1 list --json 2>/dev/null) || return 0 ;;
		kv) json=$(wrangler kv namespace list 2>/dev/null) || return 0 ;;
		*) return 0 ;;
	esac
	# Slice from the first line that starts with [ — wrangler prints a banner or an
	# account-picker line ahead of the JSON.
	printf '%s' "$json" | node -e '
		let s = "";
		process.stdin.on("data", (d) => { s += d; }).on("end", () => {
			try {
				const rows = JSON.parse(s.slice(s.search(/^\[/m)));
				const hit = rows.find((r) => [r.name ?? r.title, r.uuid ?? r.id].includes(process.argv[1]));
				if (hit) console.log(hit.uuid ?? hit.id);
			} catch {}
		});
	' "$2" || true
}

# block_field <table> <binding> <key> — the quoted value of `key` in the
# top-level [[table]] block that binds `binding`. Empty when there is none.
block_field() {
	awk -v table="$1" -v binding="$2" -v key="$3" '
		function flush() {
			if (istgt && val != "") { print val; done = 1; exit }
			istgt = 0; val = ""
		}
		BEGIN {
			q = "[\"" sprintf("%c", 39) "]"
			hdrre  = "^[[:space:]]*\\[\\[" table "\\]\\]"
			bindre = "^[[:space:]]*binding[[:space:]]*=[[:space:]]*" q binding q
			keyre  = "^[[:space:]]*" key "[[:space:]]*=[[:space:]]*" q
			pre = "^[^=]*=[[:space:]]*" q
			post = q ".*$"
		}
		/^[[:space:]]*\[/ { flush(); inblk = ($0 ~ hdrre); next }
		inblk && $0 ~ bindre { istgt = 1 }
		inblk && $0 ~ keyre { val = $0; sub(pre, "", val); sub(post, "", val) }
		END { if (!done) flush() }
	' wrangler.toml
}

# Write the id unless the binding already carries exactly it. Compares the
# target binding's own value: the id appearing elsewhere in the file (a
# comment, another binding, an environment override) proves nothing.
apply_id() {
	local setter="$1" binding="$2" id="$3" current="$4"
	if [ "$current" = "$id" ]; then
		echo "✓ $binding already points at $id"
		return
	fi
	"$setter" "$binding" "$id"
}

# create_d1 <binding> <default_database_name>
create_d1() {
	local binding="$1" name current id
	echo
	current=$(block_field d1_databases "$binding" database_id)
	# A configured id that exists in this account wins: it may be a custom
	# database, and a name lookup could point the binding somewhere else.
	if [ -n "$current" ] && [ -n "$(remote_id d1 "$current")" ]; then
		echo "✓ $binding already points at an existing D1 database — leaving it alone"
		return
	fi
	# A stale id keeps the operator's chosen database_name; the template name is
	# only the default.
	name=$(block_field d1_databases "$binding" database_name)
	name=${name:-$2}
	id=$(remote_id d1 "$name")
	if [ -n "$id" ]; then
		echo "✓ D1 database '$name' already exists in this account — reusing it"
	else
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
	fi
	if [ -z "$id" ]; then
		echo "warning: could not auto-extract database_id for $binding; copy it into wrangler.toml manually." >&2
		return
	fi
	apply_id set_d1_id "$binding" "$id" "$current"
}

create_kv() {
	local binding="$1" current id
	echo
	current=$(block_field kv_namespaces "$binding" id)
	# Same rule as create_d1: a configured id that exists here is kept, even if
	# the namespace title is not the binding name.
	if [ -n "$current" ] && [ -n "$(remote_id kv "$current")" ]; then
		echo "✓ $binding already points at an existing KV namespace — leaving it alone"
		return
	fi
	id=$(remote_id kv "$binding")
	if [ -n "$id" ]; then
		echo "✓ KV namespace '$binding' already exists in this account — reusing it"
	else
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
	fi
	if [ -z "$id" ]; then
		echo "warning: could not auto-extract id for $binding; copy manually." >&2
		return
	fi
	apply_id set_kv_id "$binding" "$id" "$current"
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
#
#   put_secret_pair <label> <hint> <name_a> <field_a> <name_b> <field_b>
#
# wrangler's own prompt is just "Enter a secret value", so each value is
# named here first: <field> is what the provider's dashboard calls it.
put_secret_pair() {
	local label="$1" hint="$2" name_a="$3" field_a="$4" name_b="$5" field_b="$6"
	echo
	read -r -p "Configure $label? ($hint) [y/N] " resp
	case "$resp" in
		y|Y|yes|YES)
			echo "  Two values follow, in this order. Paste each when wrangler asks."
			echo
			echo "  1 of 2: ${field_a:-$name_a}  (stored as $name_a)"
			wrangler secret put "$name_a"
			echo
			echo "  2 of 2: ${field_b:-$name_b}  (stored as $name_b)"
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
	put_secret_pair "Turnstile" "from dash.cloudflare.com → Turnstile" TURNSTILE_SITE_KEY "Site Key (public)" TURNSTILE_SECRET "Secret Key (private)"
	put_secret_pair "GitHub OAuth" "from github.com/settings/developers" GH_CLIENT_ID "Client ID" GH_CLIENT_SECRET "Client secret"
	put_secret_pair "Google OAuth" "from console.cloud.google.com → OAuth credentials" GOOGLE_CLIENT_ID "Client ID" GOOGLE_CLIENT_SECRET "Client secret"
	put_secret_pair "Facebook OAuth" "from developers.facebook.com → Facebook Login" FACEBOOK_CLIENT_ID "App ID" FACEBOOK_CLIENT_SECRET "App Secret"
	put_secret_pair "X/Twitter OAuth" "from developer.x.com → OAuth 2.0 (returns no email)" TWITTER_CLIENT_ID "OAuth 2.0 Client ID" TWITTER_CLIENT_SECRET "OAuth 2.0 Client Secret"
	put_secret_pair "Discord OAuth" "from discord.com/developers → OAuth2" DISCORD_CLIENT_ID "Client ID" DISCORD_CLIENT_SECRET "Client Secret"
	put_secret RESEND_API_KEY "from resend.com/api-keys"
	put_secret WEBHOOK_URL "legacy single-URL webhook; prefer /admin/webhooks endpoints"
	put_secret TELEGRAM_BOT_TOKEN "BotFather token; see docs/telegram.md"
	put_secret TELEGRAM_WEBHOOK_SECRET "shared secret for setWebhook; required for inbound commands"
	put_secret AKISMET_API_KEY "required when SPAM_PROVIDER = \"akismet\""
	put_secret AKISMET_SITE_URL "public site URL registered with Akismet"
	put_secret SPAM_FORM_TS_SECRET "HMAC key for signed form-timestamp tokens"
	put_secret CF_API_TOKEN "Analytics-read token; scopes in AGENTS-OPERATE §5"
	put_secret GITHUB_TOKEN "no-permission token; raises the 60 req/hr cap"
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

confirm_yes() {
	local resp
	read -r -p "$1 [Y/n] " resp
	case "$resp" in
		n|N|no|NO) return 1 ;;
	esac
}

# get_var <name> <file> — <name>'s value in the file's top-level [vars] table,
# either TOML quote style. Empty when absent or commented out. [env.*.vars]
# overrides are not read: setup only configures the default environment.
get_var() {
	awk -v name="$1" '
		BEGIN { dq = "\""; sq = sprintf("%c", 39) }
		/^[[:space:]]*\[/ { invars = ($0 ~ /^[[:space:]]*\[vars\][[:space:]]*(#.*)?$/); next }
		invars && $0 ~ ("^[[:space:]]*" name "[[:space:]]*=") {
			v = $0
			sub("^[^=]*=[[:space:]]*", "", v)
			# Strip only the quote style this value actually opened with, so a
			# double-quoted value containing an apostrophe (or vice versa) is
			# not cut short at that inner character.
			q = substr(v, 1, 1)
			if (q == dq || q == sq) {
				v = substr(v, 2)
				i = index(v, q)
				if (i > 0) v = substr(v, 1, i - 1)
			}
			print v
			exit
		}
	' "$2"
}

# The template ships each mustEdit var with its placeholder as the value, so
# "unchanged from wrangler.example.toml" is "not configured yet".
var_is_placeholder() {
	[ "$(get_var "$1" wrangler.toml)" = "$(get_var "$1" wrangler.example.toml)" ]
}

# set_var <name> <value> — rewrite <name>'s line in wrangler.toml's top-level
# [vars]. Same tmp-and-rename swap as set_binding_id. A missing or
# commented-out line is reported, not appended: commenting a var out is the
# operator's decision. Callers reject `"` and `\`, so the value is a plain
# TOML basic string and awk -v has no escapes to expand.
set_var() {
	local name="$1" val="$2" tmp rc
	tmp=$(mktemp ./wrangler.toml.new.XXXXXX)
	cp -p wrangler.toml "$tmp" 2>/dev/null || cp wrangler.toml "$tmp"
	set +e
	awk -v name="$name" -v val="$val" '
		/^[[:space:]]*\[/ { invars = ($0 ~ /^[[:space:]]*\[vars\][[:space:]]*(#.*)?$/) }
		invars && !done && $0 ~ ("^[[:space:]]*" name "[[:space:]]*=") {
			print name " = \"" val "\""; done = 1; next
		}
		{ print }
		END { exit done ? 0 : 4 }
	' wrangler.toml > "$tmp"
	rc=$?
	set -e
	case $rc in
		0) mv "$tmp" wrangler.toml; echo "  ✓ wrote $name into wrangler.toml" ;;
		4)
			echo "warning: no uncommented $name line in wrangler.toml [vars]." >&2
			echo "         Add $name = \"$val\" by hand." >&2 ;;
		*) echo "error: awk failed (exit $rc) setting $name; wrangler.toml unchanged." >&2 ;;
	esac
	rm -f "$tmp"
}

# var_problem <name> <value> — one-line reason the value can't work, or nothing.
# ALLOWED_ORIGINS is matched against the Origin header by exact string
# (src/lib/cors.ts), so a bare host or a trailing slash never matches and
# every embed call is then rejected with no hint why.
var_problem() {
	local name="$1" val="$2" item items
	local origin_re='^https?://[^/[:space:]]+$' url_re='^https?://[^[:space:]]+$'
	case "$name" in
		ALLOWED_ORIGINS)
			IFS=, read -ra items <<< "$val"
			for item in "${items[@]}"; do
				item="${item#"${item%%[![:space:]]*}"}"
				item="${item%"${item##*[![:space:]]}"}"
				[ -z "$item" ] && continue
				if ! [[ "$item" =~ $origin_re ]]; then
					echo "\"$item\" is not an origin — use https://host with no path or trailing slash"
					return
				fi
			done ;;
		PUBLIC_BASE_URL|OAUTH_CALLBACK_BASE)
			[[ "$val" =~ $url_re ]] || echo "\"$val\" is not a URL — start it with https://" ;;
		ADMIN_EMAILS)
			IFS=, read -ra items <<< "$val"
			for item in "${items[@]}"; do
				item="${item#"${item%%[![:space:]]*}"}"
				item="${item%"${item##*[![:space:]]}"}"
				[ -z "$item" ] && continue
				case "$item" in
					*@*.*) ;;
					*) echo "\"$item\" is not an email address"; return ;;
				esac
			done ;;
	esac
}

# prompt_var <name> <hint> — the default is the current value unless that is
# still the template placeholder. An empty answer leaves the placeholder and
# sets VARS_PENDING.
prompt_var() {
	local name="$1" hint="$2" cur ph def val msg
	cur=$(get_var "$name" wrangler.toml)
	ph=$(get_var "$name" wrangler.example.toml)
	def=""
	if [ "$cur" != "$ph" ]; then
		def="$cur"
	elif [ "$name" = OAUTH_CALLBACK_BASE ] && ! var_is_placeholder PUBLIC_BASE_URL; then
		# Same value in most setups — the provider redirect URIs hang off it.
		def=$(get_var PUBLIC_BASE_URL wrangler.toml)
	fi
	echo
	echo "$name — $hint"
	while :; do
		read -r -p "  value${def:+ [$def]}: " val
		val="${val:-$def}"
		case "$val" in
			*'"'*|*\\*) echo "  no \" or \\ allowed — try again" ;;
			*)
				# An empty answer is the skip path, so it is never validated.
				msg=""
				[ -z "$val" ] || msg=$(var_problem "$name" "$val")
				[ -z "$msg" ] && break
				echo "  $msg (try again)" ;;
		esac
	done
	if [ -z "$val" ]; then
		echo "  skipped — still the placeholder \"$ph\""
		VARS_PENDING=1
	elif [ "$val" = "$cur" ]; then
		echo "  ✓ $name unchanged"
	else
		set_var "$name" "$val"
	fi
}

configure_vars() {
	VARS_PENDING=0
# BEGIN:var-prompts
	# Generated by `npm run config:build` from scripts/config-registry.ts. Do not edit by hand.
	prompt_var ALLOWED_ORIGINS "comma-separated origins allowed to embed and call /api/*"
	prompt_var ADMIN_EMAILS "comma-separated emails that get auto-admin on OAuth signup"
	prompt_var PUBLIC_BASE_URL "public URL of this Worker; used in permalinks and email bodies"
	prompt_var OAUTH_CALLBACK_BASE "must match the redirect URI registered with each provider"
# END:var-prompts
	if [ "$VARS_PENDING" = 1 ]; then PENDING=1; fi
}

PENDING=0

echo
echo "=== Worker vars ==="
echo
echo "wrangler.toml ships four [vars] as placeholders. Enter keeps the value in"
echo "[brackets]; an empty answer leaves the placeholder for later. On"
echo "*.workers.dev, leave PUBLIC_BASE_URL and OAUTH_CALLBACK_BASE empty — the"
echo "deploy step offers to fill them from the URL wrangler prints."
echo
if confirm_yes "Set them now?"; then
	configure_vars
else
	echo "  skipped — edit [vars] in wrangler.toml by hand"
	PENDING=1
fi

# The workers.dev hostname can't be known before the first deploy, so this is
# the first point where setup can fill PUBLIC_BASE_URL for someone who chose it.
deploy_worker() {
	local log rc url
	log=$(mktemp)
	set +e
	npm run deploy 2>&1 | tee "$log"
	rc=${PIPESTATUS[0]}
	set -e
	url=$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$log" | head -1 || true)
	rm -f "$log"
	if [ "$rc" -ne 0 ]; then
		echo "error: npm run deploy failed (exit $rc). Fix the above and re-run." >&2
		exit "$rc"
	fi
	if [ -z "$url" ] || ! var_is_placeholder PUBLIC_BASE_URL; then
		return 0
	fi
	echo
	if confirm_yes "PUBLIC_BASE_URL is still the placeholder. Use $url and redeploy?"; then
		set_var PUBLIC_BASE_URL "$url"
		if var_is_placeholder OAUTH_CALLBACK_BASE; then
			set_var OAUTH_CALLBACK_BASE "$url"
		fi
		set +e
		npm run deploy
		rc=$?
		set -e
		if [ "$rc" -ne 0 ]; then
			echo "error: npm run deploy failed (exit $rc). Fix the above and re-run." >&2
			exit "$rc"
		fi
	fi
}

verify_health() {
	local base i
	base=$(get_var PUBLIC_BASE_URL wrangler.toml)
	base="${base%/}"
	if var_is_placeholder PUBLIC_BASE_URL; then
		echo "  skipped — PUBLIC_BASE_URL is still the placeholder \"$base\""
		PENDING=1
		return 0
	fi
	if ! command -v curl >/dev/null 2>&1; then
		echo "  skipped — curl not installed; open $base/api/v1/health in a browser"
		PENDING=1
		return 0
	fi
	# A fresh custom domain can take ~30s to get its certificate.
	for i in 1 2 3; do
		if curl -fsS "$base/api/v1/health"; then
			echo
			echo "✓ $base/api/v1/health answered — Garrul is live"
			return 0
		fi
		[ "$i" = 3 ] || sleep 10
	done
	echo "✗ $base/api/v1/health did not answer." >&2
	echo "  See docs/troubleshooting.md for the common failure modes." >&2
	PENDING=1
}

echo
echo "=== Migrate, deploy, verify ==="

echo
if confirm_yes "Apply the schema to production D1 (npm run migrate -- --remote)?"; then
	set +e
	npm run migrate -- --remote
	rc=$?
	set -e
	if [ $rc -ne 0 ]; then
		echo "error: npm run migrate -- --remote failed (exit $rc). Fix the above and re-run." >&2
		echo "  \"database ... could not be found [code: 7404]\" means database_id in" >&2
		echo "  wrangler.toml is not in the logged-in account (npx wrangler whoami)." >&2
		echo "  Re-running setup replaces it with the account's own." >&2
		exit $rc
	fi
else
	echo "  skipped — run later with: npm run migrate -- --remote"
	PENDING=1
fi

echo
if confirm_yes "Deploy the Worker (npm run deploy)?"; then
	deploy_worker
	echo
	if confirm_yes "Smoke-test /api/v1/health?"; then
		verify_health
	else
		PENDING=1
	fi
else
	echo "  skipped — run later with: npm run deploy"
	PENDING=1
fi

if [ "$PENDING" = 0 ]; then
	echo
	echo "=== Done ==="
	echo "Tail logs: npm run tail"
	exit 0
fi

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
