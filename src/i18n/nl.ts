/**
 * Dutch server strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Covers the surfaces a reader sees: API error bodies (the widget renders them
 * verbatim), the subscription notices, email copy and the Atom feed.
 *
 * `telegram.*` is deliberately absent. The bot talks to the operator of a
 * self-hosted install, not to readers, and it renders through the English
 * translator by design — see src/i18n/index.ts. Partial tables are the normal
 * case here: anything missing falls back to English per key.
 *
 * Register conventions, held identical to src/i18n/widget/nl.ts so the two
 * halves of one page never disagree:
 *
 *   - **No u/je where it can be avoided.** An error body under someone else's
 *     blog post has no basis for choosing, so these lines lean on impersonal
 *     phrasing ("Alleen eigen reacties kunnen worden bewerkt.") and on the
 *     imperative, which is one form for both registers in Dutch.
 *   - **"je", never "u"**, on the few lines that need a person — the unsubscribe
 *     pages and the confirmation mail, where a passive would read as evasive.
 *   - **"reactie", not "commentaar"**, for a blog comment, with "discussie" for
 *     a thread and "afmelden" for unsubscribing.
 */
import type { LocaleTable } from "./index";

export const nl = {
	// Validation / API errors
	"err.body.required": "Een reactietekst is verplicht.",
	"err.body.too_long": "De reactie is te lang (maximaal {max} tekens).",
	"err.post.required": "Bericht-id ontbreekt.",
	"err.post.invalid": "Ongeldige bericht-id.",
	"err.parent.not_found": "Bovenliggende reactie niet gevonden.",
	"err.parent.different_post": "De bovenliggende reactie hoort bij een ander bericht.",
	"err.parent.too_deep":
		"Deze discussie is te diep genest. Reageer hoger in de discussie.",
	"err.name.required": "Een weergavenaam is verplicht.",
	"err.name.too_long": "De weergavenaam is te lang (maximaal {max} tekens).",
	"err.turnstile.required": "Spamcontrole mislukt. Vernieuw de pagina en probeer het opnieuw.",
	"err.turnstile.invalid": "Spamcontrole mislukt. Vernieuw de pagina en probeer het opnieuw.",
	"err.ratelimit": "Te veel reacties — rustig aan en probeer het zo nog een keer.",
	"err.honeypot": "Reactie geweigerd.",
	// "herkomst" for the HTTP Origin — the header name itself never reaches a
	// reader, so the plain Dutch word is clearer than the loanword.
	"err.origin.forbidden": "Verzoek geblokkeerd: herkomst niet toegestaan.",
	"err.session.expired": "De sessie is verlopen. Vernieuw de pagina en probeer het opnieuw.",
	"err.edit.window_expired": "De bewerktermijn is verstreken.",
	"err.edit.not_author": "Alleen eigen reacties kunnen worden bewerkt.",
	"err.delete.not_author": "Alleen eigen reacties kunnen worden verwijderd.",
	"err.not_found": "Niet gevonden.",
	"err.banned": "Dit account is geblokkeerd.",
	"err.thread_closed": "Reacties zijn gesloten voor dit bericht.",
	"err.internal": "Er is iets misgegaan. Probeer het opnieuw.",

	// Server-rendered UI strings
	"ui.deleted": "[verwijderd]",
	"ui.subscribe.pending": "Bevestig het abonnement via de e-mail in je inbox.",
	"ui.subscribe.confirmed": "Abonnement bevestigd.",

	// Landing pages for the confirm/unsubscribe links in the email.
	// Dutch uses the curly double quote around a title, not the German „ “.
	"ui.subscribe.link_expired": "De link is verlopen of al gebruikt.",
	"ui.subscribe.confirmed_page":
		"Meldingen over reacties op “{title}” zijn bevestigd.",
	"ui.subscribe.already_unsubscribed":
		"Meldingen over reacties op “{title}” waren al afgemeld.",
	"ui.subscribe.unsubscribed":
		"Meldingen over reacties op “{title}” zijn afgemeld.",
	"ui.subscribe.unsubscribe_confirm":
		"Meldingen over reacties op “{title}” afmelden?",
	"ui.subscribe.unsubscribe_cta": "Ja, meld mij af",
	"ui.subscribe.unsubscribe_note":
		"Er is nog niets veranderd — het abonnement blijft actief tot de bevestiging.",
	// The rest of the same page: every other thread this address follows.
	"ui.subscribe.manage_others":
		"Dit adres krijgt ook meldingen voor deze discussies:",
	"ui.subscribe.unsubscribe_row_cta": "Afmelden",
	"ui.subscribe.unsubscribe_all_cta": "Voor alle discussies afmelden",
	"ui.subscribe.unsubscribed_all":
		"Meldingen over reacties zijn voor alle discussies afgemeld.",

	// Transactional email
	"email.confirm.subject": "Bevestig het abonnement op reacties bij {title}",
	"email.confirm.heading": "Abonnement bevestigen",
	"email.confirm.intro":
		"Er is een abonnement op meldingen van antwoorden bij {title} aangevraagd.",
	"email.confirm.ignore":
		"Was dit niet de bedoeling, negeer deze e-mail dan — zonder de bevestiging hieronder worden er geen verdere berichten over deze discussie naar dit adres gestuurd.",
	"email.confirm.cta": "Abonnement bevestigen",
	"email.confirm.paste": "Of plak deze link in de browser:",
	"email.digest.subject": "Nieuwe antwoorden op “{title}”",
	"email.digest.heading": {
		one: "{count} nieuwe reactie op “{title}”",
		other: "{count} nieuwe reacties op “{title}”",
	},
	"email.digest.permalink": "permalink",
	"email.digest.unsubscribe": "Afmelden voor deze discussie",

	// Atom feed
	"feed.title": "Reacties op {title}",
	"feed.entry_title": "{author} heeft gereageerd",
} satisfies LocaleTable;
