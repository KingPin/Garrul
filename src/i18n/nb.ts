/**
 * Norwegian Bokmål server strings. **Machine-seeded — not reviewed by a native
 * speaker.**
 *
 * Covers the surfaces a reader sees: API error bodies (the widget renders them
 * verbatim), the subscription notices, email copy and the Atom feed.
 *
 * `telegram.*` is deliberately absent. The bot talks to the operator of a
 * self-hosted install, not to readers, and it renders through the English
 * translator by design — see src/i18n/index.ts. Partial tables are the normal
 * case here: anything missing falls back to English per key.
 *
 * Register conventions, held identical to src/i18n/widget/nb.ts so the two
 * halves of one page never disagree:
 *
 *   - **"du", freely.** Norwegian has no live T/V split — *De* is archaic to the
 *     point of sounding satirical — so the contortions the German and Dutch
 *     tables go through to avoid Sie/du and u/je have no counterpart here.
 *     Direct address is the neutral register, and these strings use it.
 *   - **"kommentar" for a comment, "svar" for a reply, "tråd" for a thread.**
 *     Held consistently with the widget table.
 *   - **"meld av" / "avmeldt" for unsubscribing**, not "avslutt abonnementet" —
 *     shorter, and it is the wording Norwegian mail footers actually use.
 *   - **Angle quotes «…» around a title**, which is the Bokmål convention, not
 *     the curly “…” Dutch uses or the German „…“.
 */
import type { LocaleTable } from "./index";

export const nb = {
	// Validation / API errors
	"err.body.required": "Kommentarteksten er påkrevd.",
	"err.body.too_long": "Kommentaren er for lang (maks {max} tegn).",
	"err.post.required": "Innleggs-ID mangler.",
	"err.post.invalid": "Ugyldig innleggs-ID.",
	"err.parent.not_found": "Fant ikke den overordnede kommentaren.",
	"err.parent.different_post":
		"Den overordnede kommentaren hører til et annet innlegg.",
	"err.parent.too_deep":
		"Denne tråden er for dypt nøstet. Svar høyere opp i tråden i stedet.",
	"err.name.required": "Et visningsnavn er påkrevd.",
	"err.name.too_long": "Visningsnavnet er for langt (maks {max} tegn).",
	"err.turnstile.required": "Spamsjekken mislyktes. Last siden på nytt og prøv igjen.",
	"err.turnstile.invalid": "Spamsjekken mislyktes. Last siden på nytt og prøv igjen.",
	"err.ratelimit": "For mange kommentarer – ro ned og prøv igjen om litt.",
	"err.honeypot": "Kommentaren ble avvist.",
	// "opprinnelse" for the HTTP Origin. The header name never reaches a reader,
	// so the plain Norwegian word beats the loanword here.
	"err.origin.forbidden": "Forespørselen ble blokkert: opprinnelsen er ikke tillatt.",
	"err.session.expired": "Økten er utløpt. Last siden på nytt og prøv igjen.",
	"err.edit.window_expired": "Redigeringsvinduet er utløpt.",
	"err.edit.not_author": "Du kan bare redigere egne kommentarer.",
	"err.delete.not_author": "Du kan bare slette egne kommentarer.",
	"err.not_found": "Ikke funnet.",
	"err.banned": "Kontoen din er utestengt.",
	"err.thread_closed": "Kommentarfeltet er stengt for dette innlegget.",
	"err.internal": "Noe gikk galt. Prøv igjen.",

	// Server-rendered UI strings
	"ui.deleted": "[slettet]",
	"ui.subscribe.pending": "Sjekk innboksen for å bekrefte abonnementet.",
	"ui.subscribe.confirmed": "Abonnementet er bekreftet.",

	// Landing pages for the confirm/unsubscribe links in the email.
	"ui.subscribe.link_expired": "Lenken er utløpt eller allerede brukt.",
	"ui.subscribe.confirmed_page":
		"Du er påmeldt varsler om kommentarer på «{title}».",
	"ui.subscribe.already_unsubscribed":
		"Du er allerede avmeldt fra varsler om kommentarer på «{title}».",
	"ui.subscribe.unsubscribed":
		"Du er avmeldt fra varsler om kommentarer på «{title}».",
	"ui.subscribe.unsubscribe_confirm":
		"Vil du melde deg av varsler om kommentarer på «{title}»?",
	"ui.subscribe.unsubscribe_cta": "Ja, meld meg av",
	"ui.subscribe.unsubscribe_note":
		"Ingenting er endret ennå – du er fortsatt påmeldt til du bekrefter.",
	// The rest of the same page: every other thread this address follows.
	"ui.subscribe.manage_others":
		"Denne adressen får også varsler for disse trådene:",
	"ui.subscribe.unsubscribe_row_cta": "Meld av",
	"ui.subscribe.unsubscribe_all_cta": "Meld av alle tråder",
	"ui.subscribe.unsubscribed_all":
		"Du er avmeldt fra varsler om kommentarer i alle tråder.",

	// Transactional email
	"email.confirm.subject": "Bekreft abonnementet på kommentarer til {title}",
	"email.confirm.heading": "Bekreft abonnementet",
	"email.confirm.intro":
		"Du blir bedt om å bekrefte et abonnement på varsler om svar til {title}.",
	"email.confirm.ignore":
		"Var ikke dette deg, kan du se bort fra denne e-posten – uten bekreftelsen nedenfor sendes det ingen flere meldinger til denne adressen om denne tråden.",
	"email.confirm.cta": "Bekreft abonnementet",
	"email.confirm.paste": "Eller lim inn denne lenken i nettleseren:",
	"email.digest.subject": "Nye svar på «{title}»",
	"email.digest.heading": {
		one: "{count} ny kommentar på «{title}»",
		other: "{count} nye kommentarer på «{title}»",
	},
	"email.digest.permalink": "permalenke",
	"email.digest.unsubscribe": "Meld av denne tråden",

	// Atom feed
	"feed.title": "Kommentarer til {title}",
	"feed.entry_title": "{author} kommenterte",
} satisfies LocaleTable;
