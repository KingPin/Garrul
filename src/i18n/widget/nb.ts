/**
 * Norwegian Bokmål widget strings. **Machine-seeded — not reviewed by a native
 * speaker.**
 *
 * Register conventions this file commits to, so a reviewer can check them at a
 * glance and a future contributor doesn't undo them:
 *
 *   - **"du", freely.** Norwegian has no live formal/informal split, so the
 *     bare-noun-and-infinitive dance that src/i18n/widget/de.ts and nl.ts do to
 *     dodge Sie/du and u/je is not needed. Direct address is neutral here, and
 *     avoiding it would read as stilted rather than polite.
 *   - **"kommentar" for a comment, "svar" for a reply.** The Reply button is
 *     "Svar" and the composer publishes a "kommentar"; keeping the two words
 *     apart is what tells a reader which control they are looking at.
 *   - **"publisere", not "poste" or "legge ut".** One verb for the act of
 *     submitting, used on both buttons and in the anti-spam retry copy.
 *   - **"meld av" for unsubscribing, "logg ut" for signing out.** Both can be on
 *     screen at once, so they must not collapse into the same word — the trap
 *     Dutch hits with afmelden/uitloggen.
 *   - Several counted nouns are invariant in the Bokmål plural ("tegn", "svar"),
 *     so `one` and `other` below are deliberately the same string rather than an
 *     unfinished translation. Both forms are filled because the parity gate
 *     requires every reachable category, and because a future correction to the
 *     wording should not have to rediscover which forms exist.
 *
 * See src/i18n/widget/index.ts: missing keys render English, so removing a bad
 * line here is a safe correction, not a regression.
 */
import type { WidgetTable } from "./index";

export const nb = {
	// ── Composer ────────────────────────────────────────────────────────────
	"w.toolbar": "Formatering",
	"w.md.bold": "Fet",
	"w.md.italic": "Kursiv",
	"w.md.link": "Lenke",
	"w.md.code": "Kode i teksten",
	"w.md.quote": "Sitat",
	"w.md.list": "Punktliste",
	"w.md.ph.bold": "fet",
	"w.md.ph.italic": "kursiv",
	"w.md.ph.link": "tekst",
	"w.md.ph.code": "kode",
	"w.tab.write": "Skriv",
	"w.tab.preview": "Forhåndsvis",
	"w.tab.list": "Skrivemodus",
	// "Markdown" is the format's name and stays untranslated.
	"w.md_hint": "Du kan formatere med Markdown",
	"w.kbd_hint": "⌘/Ctrl + Enter for å publisere",
	// "tegn" and "svar" have no separate plural form in Bokmål — see the header.
	"w.count_left": { one: "{n} tegn igjen", other: "{n} tegn igjen" },
	"w.count_over": { one: "{n} tegn over grensen", other: "{n} tegn over grensen" },
	"w.preview.empty": "Ingenting å forhåndsvise ennå.",
	"w.preview.loading": "Laster forhåndsvisning…",
	"w.preview.failed": "Forhåndsvisningen mislyktes. Prøv igjen.",
	"w.name_ph": "Navnet ditt",
	"w.body_ph": "Skriv en kommentar…",
	// example.com is the RFC-2606 reserved example domain; a translated
	// lookalike would be somebody's real domain.
	"w.email_ph": "du@example.com",
	"w.email_label": "E-postadresse",
	"w.notify": "Varsle meg på e-post om nye kommentarer",
	"w.post_comment": "Publiser kommentar",
	"w.post_reply": "Publiser svar",
	"w.reply_ph": "Svar til @{name}…",
	"w.edit_ph": "Rediger kommentaren din…",
	"w.loading": "Laster…",
	"w.save": "Lagre",
	"w.cancel": "Avbryt",
	"w.posted": "Kommentaren er publisert",

	// ── Anti-spam ───────────────────────────────────────────────────────────
	"w.ts.title": "Spamsjekk",
	"w.ts.checking": "Sjekker…",
	"w.ts.interactive": "Fullfør spamsjekken over, og publiser på nytt.",
	"w.ts.timeout":
		"Spamsjekken ble ikke lastet. Sjekk tilkoblingen, eller last siden på nytt.",
	"w.ts.retrying":
		"Spamsjekken fikk et problem og prøver igjen. Publiser på nytt om et øyeblikk.",
	"w.ts.failed":
		"Spamsjekken kunne ikke lastes. Last siden på nytt; fortsetter det å feile, bør eieren av nettstedet sjekke at https://challenges.cloudflare.com er tilgjengelig.",

	// ── A comment ───────────────────────────────────────────────────────────
	"w.verified": "verifisert",
	"w.edited": "· redigert",
	"w.pending": "Venter på godkjenning",
	"w.removed_by_mod": "[fjernet av en moderator]",
	"w.deleted": "[slettet]",
	"w.lowscore.hide": "Skjul kommentaren",
	"w.lowscore.show": "Kommentaren er skjult (lav poengsum) – vis",
	"w.reply": "Svar",
	"w.edit": "Rediger",
	// "4 min igjen" — `{time}` arrives already formatted by Intl, unit included.
	"w.edit_left": "{time} igjen",
	"w.edit_last_minute": "mindre enn ett minutt igjen",
	"w.edit_expired": "Redigeringsvinduet er lukket.",
	"w.delete": "Slett",
	"w.delete_confirm": "Slette denne kommentaren?",
	"w.report": "Rapporter",
	"w.reported": "Rapportert, takk",

	// ── Votes and reactions ─────────────────────────────────────────────────
	"w.vote.up": "Stem opp",
	"w.vote.down": "Stem ned",
	"w.page.helpful": "Var dette nyttig?",
	"w.page.up": "Stem opp denne siden",
	"w.page.down": "Stem ned denne siden",
	// Deliberately not "Hva er din reaksjon?" — a literal rendering reads like a
	// survey. "Hva synes du?" is what a Norwegian site puts over an emoji row.
	"w.page.react_prompt": "Hva synes du?",
	"w.react.fire": "Briljant",
	// ❤️. "Kjærlighet" is the emotion, not a verdict on a post, so this is the
	// verb phrase instead — still short enough for the six-across row.
	"w.react.love": "Elsker det",
	"w.react.wow": "Wow",
	// Neuter, agreeing with the content being judged rather than with a person.
	"w.react.laugh": "Morsomt",
	"w.react.hmm": "Hmm",
	"w.react.cry": "Trist",

	// ── The thread ──────────────────────────────────────────────────────────
	"w.replies": { one: "{n} svar", other: "{n} svar" },
	"w.more_replies": { one: "Vis {n} svar til", other: "Vis {n} svar til" },
	"w.loading_comments": "Laster kommentarer",
	"w.permalink": "Permalenke til kommentaren fra @{name}, {time}",
	"w.region": "Kommentarer",
	"w.empty.open": "Bli den første som kommenterer.",
	"w.empty.closed": "Ingen kommentarer ennå.",
	"w.closed.post": "Kommentarfeltet er stengt for dette innlegget.",
	"w.closed.aged": "Denne tråden er stengt for nye kommentarer.",
	"w.closed.sunset": "Kommenteringen er avsluttet.",
	"w.closed.other": "Kommentarfeltet er stengt.",
	"w.sort_by": "Sorter etter {control}",
	"w.sort.new": "Nyeste",
	"w.sort.old": "Eldste",
	"w.sort.top": "Beste",
	"w.subscribe": "Varsle meg på e-post om nye kommentarer på dette innlegget",
	"w.subscribe.submit": "Abonner",
	"w.subscribe.done": "Sjekk e-posten din for å bekrefte.",
	"w.subscribe.failed": "Kunne ikke abonnere. Prøv igjen.",
	"w.subscribe.ratelimit": "For mange forespørsler. Prøv igjen senere.",
	"w.subscribe.awaiting": "Bekreft e-posten vi sendte, eller trykk for å avbryte",
	"w.unsubscribe": "Slutt å varsle meg om nye kommentarer på dette innlegget",
	"w.unsubscribe.done": "Du får ikke flere e-poster om denne tråden.",
	"w.unsubscribe.failed": "Kunne ikke melde av. Prøv igjen.",
	"w.unsubscribe.row": "Meld av",
	"w.manage": "Administrer abonnementer",
	"w.manage.empty": "Du følger ingen tråder.",
	"w.manage.failed": "Kunne ikke laste abonnementene dine.",
	"w.load_more": "Last eldre kommentarer",
	"w.load_more_failed": "Kunne ikke laste mer: {detail}",

	// ── Identity ────────────────────────────────────────────────────────────
	"w.posting_as": "Publiserer som {name}",
	// "Logg ut", never "meld av": that is the unsubscribe verb a few lines up,
	// and both buttons can be on screen together.
	"w.sign_out": "Logg ut",
	"w.signin_prompt": "Logg inn for å få et verifisert merke:",

	// ── Load failures ───────────────────────────────────────────────────────
	"w.err.transient":
		"Kommentarene er midlertidig utilgjengelige. Prøv igjen om noen minutter.",
	"w.err.generic": "Kunne ikke laste kommentarene.",

	// ── Attribution ─────────────────────────────────────────────────────────
	// "Garrul" is a product name and stays untranslated inside {link}.
	"w.powered_by": "Drevet av {link}",
} satisfies WidgetTable;
