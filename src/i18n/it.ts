/**
 * Italian server strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Covers the surfaces a reader sees: API error bodies (the widget renders them
 * verbatim), the subscription notices, email subjects and the Atom feed.
 *
 * `telegram.*` is deliberately absent. The bot talks to the operator of a
 * self-hosted install, not to readers, and it renders through the English
 * translator by design — see src/i18n/index.ts. Partial tables are the normal
 * case here: anything missing falls back to English per key.
 *
 * Register, held identical to src/i18n/widget/it.ts so the two surfaces never
 * disagree mid-flow:
 *
 *   - **Informal "tu"**, never "Lei" — an error body under a blog post is
 *     consumer web, and "Lei" reads as a bank letter.
 *   - **Second-person-singular imperative for actions** ("Riprova", "Ricarica
 *     la pagina", "Conferma l'iscrizione").
 *   - **Impersonal phrasing wherever a notice can avoid addressing anyone**
 *     ("Link scaduto o già utilizzato.", "Iscrizione confermata.").
 *   - Italian quotation marks are «caporali», matching the German file's use of
 *     its own native pair rather than copying the English straight quotes.
 */
import type { LocaleTable } from "./index";

export const it = {
	// Validation / API errors
	"err.body.required": "Il testo del commento è obbligatorio.",
	"err.body.too_long": "Il commento è troppo lungo (massimo {max} caratteri).",
	"err.post.required": "Identificatore dell'articolo mancante.",
	"err.post.invalid": "Identificatore dell'articolo non valido.",
	// "commento padre" is the term Italian developers use, but this string is
	// read by someone who just pressed Reply, so it says what they did instead.
	"err.parent.not_found": "Il commento a cui stai rispondendo non è stato trovato.",
	"err.parent.different_post":
		"Il commento a cui stai rispondendo appartiene a un altro articolo.",
	"err.parent.too_deep":
		"Questa discussione ha troppi livelli di annidamento. Rispondi più in alto nella discussione.",
	"err.name.required": "È obbligatorio un nome visualizzato.",
	"err.name.too_long": "Il nome visualizzato è troppo lungo (massimo {max} caratteri).",
	"err.turnstile.required": "Controllo antispam non riuscito. Ricarica la pagina e riprova.",
	"err.turnstile.invalid": "Controllo antispam non riuscito. Ricarica la pagina e riprova.",
	"err.ratelimit": "Troppi commenti — rallenta e riprova tra un momento.",
	"err.honeypot": "Commento rifiutato.",
	"err.origin.forbidden": "Richiesta bloccata: origine non consentita.",
	"err.session.expired": "La tua sessione è scaduta. Ricarica la pagina e riprova.",
	"err.edit.window_expired": "Il tempo per modificare è scaduto.",
	"err.edit.not_author": "Puoi modificare solo i tuoi commenti.",
	"err.delete.not_author": "Puoi eliminare solo i tuoi commenti.",
	"err.not_found": "Non trovato.",
	// "bloccato", not "bandito": a ban here is an account block, and "bandito"
	// also means "bandit" in Italian.
	"err.banned": "Il tuo account è bloccato.",
	"err.thread_closed": "I commenti sono chiusi per questo articolo.",
	"err.internal": "Si è verificato un errore. Riprova.",

	// Server-rendered UI strings
	"ui.deleted": "[eliminato]",
	"ui.subscribe.pending": "Controlla la tua casella di posta per confermare l'iscrizione.",
	"ui.subscribe.confirmed": "Iscrizione confermata.",

	// Landing pages for the confirm/unsubscribe links in the email
	"ui.subscribe.link_expired": "Link scaduto o già utilizzato.",
	"ui.subscribe.confirmed_page":
		"Le notifiche sui commenti di «{title}» sono confermate.",
	"ui.subscribe.already_unsubscribed":
		"Hai già annullato le notifiche sui commenti di «{title}».",
	"ui.subscribe.unsubscribed": "Hai annullato le notifiche sui commenti di «{title}».",
	"ui.subscribe.unsubscribe_confirm":
		"Vuoi annullare le notifiche sui commenti di «{title}»?",
	"ui.subscribe.unsubscribe_cta": "Sì, annulla l'iscrizione",
	"ui.subscribe.unsubscribe_note":
		"Non è ancora cambiato nulla — resti iscritto finché non confermi.",
	// The rest of the same page: the other threads this address follows.
	"ui.subscribe.manage_others":
		"Questo indirizzo riceve notifiche anche per queste discussioni:",
	"ui.subscribe.unsubscribe_row_cta": "Annulla iscrizione",
	"ui.subscribe.unsubscribe_all_cta": "Annulla l'iscrizione a tutte le discussioni",
	"ui.subscribe.unsubscribed_all":
		"Hai annullato le notifiche sui commenti di tutte le discussioni.",

	// Transactional email
	"email.confirm.subject": "Conferma l'iscrizione ai commenti di {title}",
	"email.confirm.heading": "Conferma l'iscrizione",
	"email.confirm.intro":
		"È stata richiesta un'iscrizione alle notifiche di risposta per {title}.",
	"email.confirm.ignore":
		"Se non sei stato tu, ignora questa email — senza il clic di conferma qui sotto, a questo indirizzo non verrà inviato nessun altro messaggio per questa discussione.",
	"email.confirm.cta": "Conferma l'iscrizione",
	"email.confirm.paste": "Oppure incolla questo link nel browser:",
	"email.digest.subject": "Nuove risposte su «{title}»",
	"email.digest.heading": {
		one: "{count} nuovo commento su «{title}»",
		other: "{count} nuovi commenti su «{title}»",
	},
	"email.digest.permalink": "permalink",
	"email.digest.unsubscribe": "Annulla le notifiche per questa discussione",

	// Atom feed
	"feed.title": "Commenti su {title}",
	"feed.entry_title": "{author} ha commentato",
} satisfies LocaleTable;
