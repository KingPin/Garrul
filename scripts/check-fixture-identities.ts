#!/usr/bin/env tsx
// Fail the build if anything under tests/ carries a real-world identity.
//
//   npm run identity:check
//
// WHY THIS IS AN INVARIANT AND NOT A GREP. The obvious check — search tests/ for
// the maintainer's address — would have to *contain* the maintainer's address,
// in a public repository, forever. So this encodes the shape a fixture identity
// is allowed to have instead:
//
//   emails            reserved domains only (RFC 2606 / RFC 6761)
//   avatar URLs       never, when they carry an account id or a hash
//   profile URLs      never
//   identity fields   placeholder-shaped values only
//
// Stating it that way catches leaks nobody anticipated, which is the entire
// difference between a guard and a reminder. It also means the rules can be
// read, argued with, and widened on purpose.
//
// THIS SHIPS BEFORE THE FIXTURES IT GUARDS. Today tests/ contains no data files
// and no identity fields at all, so rules 3 and 4 match nothing and cost
// nothing. That is the point: a guard added alongside the thing it guards has
// already failed once by definition, and the first import fixture is exactly
// the commit where a tired reviewer waves through an author name. By then the
// rule needs to already exist.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not try to recognise a real human
// name in prose — "Ana-Lucía Ferrer" and "Alice Example" are the same string to
// a regex, and a check with false positives gets suppressed rather than fixed.
// The defence for names is that fixtures are hand-written from measured shapes,
// never pasted from a real export. See docs/design.md in the import lab.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.argv[2] ?? "tests";

// RFC 2606 §3 reserves these second-level domains for documentation and
// examples; RFC 6761 reserves the TLDs. Subdomains of a reserved domain are
// reserved too, which is what lets a test say evil.example.com and mean it.
const RESERVED_DOMAINS = new Set(["example.com", "example.net", "example.org", "example.edu"]);
const RESERVED_TLDS = new Set(["test", "invalid", "localhost", "example"]);

// Values an identity field may hold. Anything that reads as a placeholder on
// sight — the reviewer should not have to check whether an account exists.
const PLACEHOLDER_VALUE = /^(?:example|test|fixture|anon|guest|placeholder|deleted|unknown)[a-z0-9_-]*$/i;

type Violation = { file: string; line: number; rule: string; detail: string };

function isReservedDomain(domain: string): boolean {
	const labels = domain.toLowerCase().split(".");
	if (RESERVED_TLDS.has(labels.at(-1) ?? "")) return true;
	return RESERVED_DOMAINS.has(labels.slice(-2).join("."));
}

// --- the rules ----------------------------------------------------------------
//
// Each returns the violations on one line. They are separate functions rather
// than one regex so that a rule can be relaxed without weakening its neighbours
// — the failure mode of a single mega-pattern is that widening it for one case
// silently widens it for the rest.

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function checkEmails(line: string): Violation[] {
	const out: Violation[] = [];
	for (const m of line.matchAll(EMAIL)) {
		const domain = m[1] ?? "";
		if (!isReservedDomain(domain)) {
			out.push({ file: "", line: 0, rule: "email", detail: `${m[0]} — use a reserved domain (example.com/.net/.org, or a .test host)` });
		}
	}
	return out;
}

// An avatar URL is the purest form of this leak: it carries an account id or a
// hash of an address, so it identifies a person even after the name beside it
// has been swapped for a fake one. There is no legitimate reason for one to
// appear in a fixture — Garrul renders identicons for anonymous authors and
// stores the provider URL only for real OAuth sessions, neither of which is
// something tests/ needs a live example of.
const AVATAR = /(?:avatars\.githubusercontent\.com\/u\/\d+|gravatar\.com\/avatar\/[0-9a-f]{16,}|secure\.gravatar\.com\/avatar\/[0-9a-f]{16,})/gi;

function checkAvatars(line: string): Violation[] {
	return [...line.matchAll(AVATAR)].map((m) => ({
		file: "",
		line: 0,
		rule: "avatar-url",
		detail: `${m[0]} — carries an account id or address hash; fixtures must not reference a real avatar`,
	}));
}

// A bare profile URL — github.com/<owner> with nothing after it. The project's
// own coordinates are deliberately still allowed, because they are a repository
// path (github.com/<owner>/<repo>/releases/...) and appear in tests that assert
// on release URLs. The distinction is the path shape, not the owner: an owner
// allowlist could not tell the maintainer's account from the maintainer's repo,
// and it is the account that leaks.
const PROFILE = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/?(?![A-Za-z0-9/-])/g;

function checkProfiles(line: string): Violation[] {
	return [...line.matchAll(PROFILE)].map((m) => ({
		file: "",
		line: 0,
		rule: "profile-url",
		detail: `${m[0]} — a bare profile URL names an account; reference a repository path or drop it`,
	}));
}

// Account handles, and deliberately not display names. A handle is an account
// on somebody else's service — it resolves to a profile, so it is an identifier
// whatever value it holds, and demanding a placeholder costs nothing. A display
// name is free text: tests/ is already full of Alice, Ada and Mallory, and no
// rule can separate those from a real person's name without the deny-list this
// guard exists to avoid. Keying on the field name rather than the value is what
// makes that distinction expressible at all.
const IDENTITY_FIELD = /["']?\b(login|username|user_name|nickname|handle|screen_name|authorLogin)["']?\s*[:=]\s*["']([^"']*)["']/g;

function checkIdentityFields(line: string): Violation[] {
	const out: Violation[] = [];
	for (const m of line.matchAll(IDENTITY_FIELD)) {
		const value = m[2] ?? "";
		if (value === "" || PLACEHOLDER_VALUE.test(value)) continue;
		out.push({
			file: "",
			line: 0,
			rule: "identity-field",
			detail: `${m[1]}="${value}" — must read as a placeholder (example*, test*, fixture*, anon*, guest*)`,
		});
	}
	return out;
}

const RULES = [checkEmails, checkAvatars, checkProfiles, checkIdentityFields];

// --- walk ---------------------------------------------------------------------

function* files(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) yield* files(path);
		else yield path;
	}
}

// Repo-relative where that is shorter, absolute where it is not — a root
// outside the tree (the guard's own tests pass one) would otherwise print a
// ladder of "../" that is longer than the path it replaces.
const display = (path: string): string => {
	const rel = relative(".", path);
	return rel.startsWith("..") ? path : rel;
};

const violations: Violation[] = [];

for (const path of files(ROOT)) {
	const buf = readFileSync(path);
	// A NUL byte means this is not text. Nothing binary should be under tests/,
	// but decoding one as UTF-8 would produce replacement characters and a stream
	// of nonsense matches rather than an honest "cannot check this".
	if (buf.includes(0)) {
		violations.push({ file: display(path), line: 0, rule: "binary", detail: `binary file under ${ROOT}/ — cannot be checked for identities` });
		continue;
	}
	const lines = new TextDecoder("utf-8").decode(buf).split("\n");
	lines.forEach((line, i) => {
		for (const rule of RULES) {
			for (const v of rule(line)) violations.push({ ...v, file: display(path), line: i + 1 });
		}
	});
}

if (violations.length) {
	console.error(`${violations.length} identity violation${violations.length === 1 ? "" : "s"} under ${ROOT}/:\n`);
	for (const v of violations) console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.detail}`);
	console.error(
		"\nFixtures carry invented identities only. If this is a real export, it does not\n" +
			"belong in this repository — see docs/design.md in the import lab for why the\n" +
			"raw captures stay private and the committed fixtures are hand-written.",
	);
	process.exit(1);
}

console.log(`no real-world identities under ${ROOT}/`);
