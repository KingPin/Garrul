/**
 * Lightweight, in-core anti-spam heuristics. Pure functions (one DB read for
 * `isFirstComment`); no external dependencies. Each heuristic is independently
 * gated by its env var — when unset, the caller skips it entirely.
 *
 * A `true` flag downgrades the eventual `insertComment` status to `'pending'`.
 * Nothing here 400s the request; flagged comments still land in D1 and appear
 * in the admin queue at /admin/queue?status=pending.
 */

const encoder = new TextEncoder();

/**
 * HMAC-SHA-256 of the timestamp (ms since epoch) using SPAM_FORM_TS_SECRET.
 * Token format: "<ms>.<hex-sig>". Verification recomputes the sig and checks
 * elapsed time against `minMs`.
 *
 * Kept in this file (rather than reused from lib/ip-hash) because the input
 * here is a number and we want a stable, self-contained API for tests.
 */
const importHmacKey = (secret: string): Promise<CryptoKey> =>
	crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

const hex = (buf: ArrayBuffer): string =>
	Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Mint a signed form-render timestamp. The widget submits this back; the
 * server checks that enough wall-clock time has passed before accepting.
 */
export const signFormTimestamp = async (
	nowMs: number,
	secret: string,
): Promise<string> => {
	const key = await importHmacKey(secret);
	const sig = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(String(nowMs)),
	);
	return `${nowMs}.${hex(sig)}`;
};

/**
 * Verify a form-render timestamp token.
 *
 * Returns `{ flag: true }` if the token is missing, malformed, fails HMAC
 * verification, OR the elapsed wall-clock time is below `minMs`. Returns
 * `{ flag: false }` only when the token is genuine AND the human spent at
 * least `minMs` filling the form.
 */
export const verifyFormTimestamp = async (
	token: string | undefined,
	secret: string,
	nowMs: number,
	minMs: number,
): Promise<{ flag: boolean; reason?: string }> => {
	if (!token) return { flag: true, reason: "form_ts.missing" };
	const dot = token.indexOf(".");
	if (dot <= 0) return { flag: true, reason: "form_ts.malformed" };
	const tsRaw = token.slice(0, dot);
	const sigRaw = token.slice(dot + 1);
	const ts = Number.parseInt(tsRaw, 10);
	if (!Number.isFinite(ts)) return { flag: true, reason: "form_ts.malformed" };

	const key = await importHmacKey(secret);
	const expected = hex(
		await crypto.subtle.sign("HMAC", key, encoder.encode(String(ts))),
	);
	// Constant-time compare on equal-length strings.
	if (expected.length !== sigRaw.length) {
		return { flag: true, reason: "form_ts.bad_sig" };
	}
	let diff = 0;
	for (let i = 0; i < expected.length; i++) {
		diff |= expected.charCodeAt(i) ^ sigRaw.charCodeAt(i);
	}
	if (diff !== 0) return { flag: true, reason: "form_ts.bad_sig" };

	const elapsed = nowMs - ts;
	// Negative elapsed = clock skew or replayed-from-future. Treat as flag.
	if (elapsed < 0) return { flag: true, reason: "form_ts.future" };
	if (elapsed < minMs) return { flag: true, reason: "form_ts.too_fast" };
	return { flag: false };
};

/**
 * Count URL-like substrings in the markdown body. Anything matching
 * `http(s)://` or `mailto:` schemes counts — matches the renderer allowlist
 * in src/lib/markdown.ts. Scheme-less domains (e.g. `www.example.com`)
 * are NOT counted; if a spammer relies on the gfm autolinker to make a
 * bare domain clickable, this signal misses it, but the rendered HTML
 * will still go through the strict sanitizer.
 */
const URL_RE = /\b(?:https?:\/\/|mailto:)\S+/gi;
export const countLinks = (bodyMd: string): number => {
	if (!bodyMd) return 0;
	const matches = bodyMd.match(URL_RE);
	return matches ? matches.length : 0;
};

/**
 * True when this is the author's first-ever comment (no prior rows in D1
 * keyed on user_id). Caller gates on SPAM_FIRST_COMMENT_MODERATE before
 * paying the query.
 */
export const isFirstComment = async (
	db: D1Database,
	userId: string,
): Promise<boolean> => {
	const row = await db
		.prepare(`SELECT 1 AS one FROM comments WHERE user_id = ? LIMIT 1`)
		.bind(userId)
		.first<{ one: number } | null>();
	return row == null;
};
