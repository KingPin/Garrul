/**
 * Dutch widget strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Register conventions this file commits to, so a reviewer can check them at a
 * glance and a future contributor doesn't undo them:
 *
 *   - **No direct address where it can be avoided.** Dutch has the same u/je
 *     problem German has with Sie/du, and a comment box under someone else's
 *     blog post has no basis for choosing. Bare nouns and infinitives ("Naam",
 *     "Reactie bewerken…") sidestep it, which is what most Dutch sites do.
 *   - **Imperatives are safe.** Unlike the pronouns, the Dutch imperative is one
 *     form for both registers ("Laad de pagina opnieuw"), so instruction strings
 *     use it rather than contorting into a passive.
 *   - **"je", never "u"**, on the handful of lines that genuinely need a person.
 *     Mixing the two inside one widget is worse than either choice alone.
 *   - **"reactie", not "commentaar".** A blog comment is a *reactie* in Dutch;
 *     "commentaar" reads as commentary or critique. Held consistently here and
 *     in src/i18n/nl.ts, including the derived verb "reageren".
 *   - Dutch runs a little longer than English, so the strings that sit in tight
 *     controls (the sort dropdown, the six-across reaction row) are kept short.
 *
 * See src/i18n/widget/index.ts: missing keys render English, so removing a bad
 * line here is a safe correction, not a regression.
 */
import type { WidgetTable } from "./index";

export const nl = {
	// ── Composer ────────────────────────────────────────────────────────────
	"w.toolbar": "Opmaak",
	"w.md.bold": "Vet",
	"w.md.italic": "Cursief",
	"w.md.link": "Link",
	"w.md.code": "Inline code",
	"w.md.quote": "Citaat",
	"w.md.list": "Opsomming",
	"w.md.ph.bold": "vet",
	"w.md.ph.italic": "cursief",
	"w.md.ph.link": "tekst",
	"w.md.ph.code": "code",
	"w.tab.write": "Schrijven",
	"w.tab.preview": "Voorbeeld",
	"w.tab.list": "Bewerkmodus",
	// "Markdown" is the format's name and stays untranslated.
	"w.md_hint": "Opmaak met Markdown wordt ondersteund",
	"w.kbd_hint": "⌘/Ctrl + Enter om te plaatsen",
	"w.count_left": { one: "nog {n} teken", other: "nog {n} tekens" },
	"w.count_over": { one: "{n} teken te veel", other: "{n} tekens te veel" },
	"w.preview.empty": "Nog niets om te tonen.",
	"w.preview.loading": "Voorbeeld laden…",
	"w.preview.failed": "Voorbeeld mislukt. Probeer het opnieuw.",
	"w.name_ph": "Naam",
	"w.body_ph": "Reactie toevoegen…",
	// example.com is the RFC-2606 reserved example domain; a translated
	// lookalike would be somebody's real domain.
	"w.email_ph": "naam@example.com",
	"w.email_label": "E-mailadres",
	// First person ("mij"), not second — it keeps the checkbox out of the u/je
	// choice while still reading as the reader's own request.
	"w.notify": "Mij e-mailen bij nieuwe reacties",
	"w.post_comment": "Reactie plaatsen",
	"w.post_reply": "Antwoord plaatsen",
	"w.reply_ph": "Antwoord aan @{name}…",
	"w.edit_ph": "Reactie bewerken…",
	"w.loading": "Laden…",
	"w.save": "Opslaan",
	"w.cancel": "Annuleren",
	"w.posted": "Reactie geplaatst",

	// ── Anti-spam ───────────────────────────────────────────────────────────
	"w.ts.title": "Spamcontrole",
	"w.ts.checking": "Controleren…",
	"w.ts.interactive": "Voltooi de spamcontrole hierboven en plaats de reactie opnieuw.",
	"w.ts.timeout":
		"De spamcontrole is niet geladen. Controleer de verbinding of laad de pagina opnieuw.",
	"w.ts.retrying":
		"De spamcontrole liep vast en probeert het opnieuw. Plaats de reactie zo nog een keer.",
	"w.ts.failed":
		"De spamcontrole kon niet worden geladen. Laad de pagina opnieuw; blijft het misgaan, dan moet de sitebeheerder controleren of https://challenges.cloudflare.com bereikbaar is.",

	// ── A comment ───────────────────────────────────────────────────────────
	"w.verified": "geverifieerd",
	"w.edited": "· bewerkt",
	"w.pending": "Wacht op goedkeuring",
	"w.removed_by_mod": "[verwijderd door een moderator]",
	"w.deleted": "[verwijderd]",
	"w.lowscore.hide": "Reactie verbergen",
	"w.lowscore.show": "Reactie verborgen (lage score) — tonen",
	// "Antwoorden", not "Reageren": inside a thread this button adds a reply to
	// one comment, and "reageren" is already the verb for the composer at the
	// top of the page.
	"w.reply": "Antwoorden",
	"w.edit": "Bewerken",
	// "nog 4 min." — `{time}` arrives already formatted by Intl, unit included.
	"w.edit_left": "nog {time}",
	"w.edit_last_minute": "minder dan een minuut over",
	"w.edit_expired": "De bewerktermijn is verstreken.",
	"w.delete": "Verwijderen",
	"w.delete_confirm": "Deze reactie verwijderen?",
	"w.report": "Melden",
	"w.reported": "Gemeld, bedankt",

	// ── Votes and reactions ─────────────────────────────────────────────────
	"w.vote.up": "Positief beoordelen",
	"w.vote.down": "Negatief beoordelen",
	"w.page.helpful": "Was dit nuttig?",
	"w.page.up": "Deze pagina positief beoordelen",
	"w.page.down": "Deze pagina negatief beoordelen",
	// Deliberately not "Wat is je reactie?" — "reactie" is this widget's word for
	// a written comment, and the emoji row is not that.
	"w.page.react_prompt": "Wat vind je ervan?",
	"w.react.fire": "Briljant",
	// ❤️. "Liefde" is the emotion, not a verdict on a post; "Geweldig" is the
	// label Dutch social UIs put on this reaction.
	"w.react.love": "Geweldig",
	"w.react.wow": "Wauw",
	"w.react.laugh": "Grappig",
	"w.react.hmm": "Hmm",
	// "Triest" over the longer "Verdrietig" — six of these share one row.
	"w.react.cry": "Triest",

	// ── The thread ──────────────────────────────────────────────────────────
	"w.replies": { one: "{n} antwoord", other: "{n} antwoorden" },
	"w.more_replies": {
		one: "Nog {n} antwoord tonen",
		other: "Nog {n} antwoorden tonen",
	},
	"w.loading_comments": "Reacties laden",
	"w.permalink": "Permalink naar de reactie van @{name}, {time}",
	"w.region": "Reacties",
	// Infinitive, not the imperative "Wees de eerste" — the no-direct-address
	// rule, and this is a label rather than an instruction.
	"w.empty.open": "Plaats de eerste reactie.",
	"w.empty.closed": "Nog geen reacties.",
	"w.closed.post": "Reacties zijn gesloten voor dit bericht.",
	// "discussie" for thread throughout; the English loanword reads as technical
	// jargon in a reader-facing string.
	"w.closed.aged": "Deze discussie is gesloten voor nieuwe reacties.",
	"w.closed.sunset": "Reageren is niet meer mogelijk.",
	"w.closed.other": "Reacties zijn gesloten.",
	"w.sort_by": "Sorteren op {control}",
	"w.sort.new": "Nieuwste",
	"w.sort.old": "Oudste",
	"w.sort.top": "Beste",
	"w.subscribe": "Mij e-mailen bij nieuwe reacties op dit bericht",
	"w.subscribe.submit": "Abonneren",
	"w.subscribe.done": "Bevestig via de e-mail die we hebben gestuurd.",
	"w.subscribe.failed": "Abonneren is mislukt. Probeer het opnieuw.",
	"w.subscribe.ratelimit": "Te veel verzoeken. Probeer het later opnieuw.",
	"w.subscribe.awaiting": "Bevestig de e-mail die we stuurden, of druk om te annuleren",
	"w.unsubscribe": "Geen e-mail meer bij nieuwe reacties op dit bericht",
	"w.unsubscribe.done": "Je krijgt geen e-mail meer over deze discussie.",
	"w.unsubscribe.failed": "Afmelden is mislukt. Probeer het opnieuw.",
	"w.unsubscribe.row": "Afmelden",
	"w.manage": "Abonnementen beheren",
	"w.manage.empty": "Je volgt nog geen discussies.",
	"w.manage.failed": "De abonnementen konden niet worden geladen.",
	"w.load_more": "Oudere reacties laden",
	"w.load_more_failed": "Er kon niet meer worden geladen: {detail}",

	// ── Identity ────────────────────────────────────────────────────────────
	"w.posting_as": "Plaatsen als {name}",
	// "Uitloggen", not "Afmelden": "afmelden" is already the unsubscribe verb a
	// few lines up, and the two buttons can be on screen together.
	"w.sign_out": "Uitloggen",
	"w.signin_prompt": "Inloggen voor een verificatiebadge:",

	// ── Load failures ───────────────────────────────────────────────────────
	"w.err.transient":
		"Reacties zijn tijdelijk niet beschikbaar. Kom over een paar minuten terug.",
	"w.err.generic": "De reacties konden niet worden geladen.",

	// ── Attribution ─────────────────────────────────────────────────────────
	// "Garrul" is a product name and stays untranslated inside {link}.
	"w.powered_by": "Mogelijk gemaakt door {link}",
} satisfies WidgetTable;
