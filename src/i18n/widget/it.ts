/**
 * Italian widget strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Register conventions this file commits to, so a reviewer can check them at a
 * glance and a future contributor doesn't undo them:
 *
 *   - **Informal "tu"**, never "Lei". A comment box under someone's blog post is
 *     consumer web, where "Lei" reads as a bank letter. The same choice is made
 *     in src/i18n/it.ts, so the two surfaces never disagree mid-flow.
 *   - **Second-person-singular imperative for every action** — "Salva",
 *     "Annulla", "Rispondi" — which is what Italian UI does with buttons, rather
 *     than the infinitive ("Salvare") that transliterating English invites.
 *   - **Impersonal phrasing for notices**, so a status line doesn't have to
 *     address anyone: "Caricamento…", "I commenti sono chiusi.".
 *   - Italian runs longer than English, so the strings sitting in tight controls
 *     (buttons, the sort dropdown, the six-across reaction row) are kept to one
 *     word wherever the language allows it.
 *   - Italian selects only `one` (n=1) and `other` for integers, so every plural
 *     entry here carries exactly those two forms.
 *
 * See src/i18n/widget/index.ts: missing keys render English, so removing a bad
 * line here is a safe correction, not a regression.
 */
import type { WidgetTable } from "./index";

export const it = {
	// ── Composer ────────────────────────────────────────────────────────────
	"w.toolbar": "Formattazione",
	"w.md.bold": "Grassetto",
	"w.md.italic": "Corsivo",
	// "Link" over "Collegamento": the loanword is what Italian UI uses, and the
	// native word is long enough to wrap the toolbar tooltip.
	"w.md.link": "Link",
	"w.md.code": "Codice inline",
	"w.md.quote": "Citazione",
	"w.md.list": "Elenco puntato",
	"w.md.ph.bold": "grassetto",
	"w.md.ph.italic": "corsivo",
	"w.md.ph.link": "testo",
	"w.md.ph.code": "codice",
	"w.tab.write": "Scrivi",
	"w.tab.preview": "Anteprima",
	"w.tab.list": "Modalità di scrittura",
	// "Markdown" is a proper noun and stays as it is.
	"w.md_hint": "È supportata la formattazione con Markdown",
	// "Invio" is what an Italian keyboard prints on the Enter key; ⌘/Ctrl are
	// glyphs and stay verbatim.
	"w.kbd_hint": "⌘/Ctrl + Invio per pubblicare",
	"w.count_left": { one: "{n} carattere rimanente", other: "{n} caratteri rimanenti" },
	"w.count_over": {
		one: "{n} carattere oltre il limite",
		other: "{n} caratteri oltre il limite",
	},
	"w.preview.empty": "Ancora nulla da mostrare in anteprima.",
	"w.preview.loading": "Caricamento dell'anteprima…",
	"w.preview.failed": "Anteprima non riuscita. Riprova.",
	"w.name_ph": "Il tuo nome",
	"w.body_ph": "Aggiungi un commento…",
	// example.com is the RFC-2606 reserved example domain; a translated
	// lookalike would be somebody's real domain.
	"w.email_ph": "nome@example.com",
	"w.email_label": "Indirizzo email",
	"w.notify": "Inviami un'email sui nuovi commenti",
	"w.post_comment": "Pubblica commento",
	"w.post_reply": "Pubblica risposta",
	"w.reply_ph": "Rispondi a @{name}…",
	"w.edit_ph": "Modifica il tuo commento…",
	"w.loading": "Caricamento…",
	"w.save": "Salva",
	"w.cancel": "Annulla",
	"w.posted": "Commento pubblicato",

	// ── Anti-spam ───────────────────────────────────────────────────────────
	"w.ts.title": "Controllo antispam",
	"w.ts.checking": "Controllo in corso…",
	"w.ts.interactive": "Completa il controllo antispam qui sopra, poi pubblica di nuovo.",
	"w.ts.timeout":
		"Il controllo antispam non si è caricato. Controlla la connessione o ricarica la pagina.",
	"w.ts.retrying":
		"Il controllo antispam ha avuto un problema e sta riprovando. Pubblica di nuovo tra un momento.",
	"w.ts.failed":
		"Impossibile caricare il controllo antispam. Ricarica la pagina; se continua a non funzionare, il proprietario del sito dovrebbe verificare che https://challenges.cloudflare.com sia raggiungibile.",

	// ── A comment ───────────────────────────────────────────────────────────
	"w.verified": "verificato",
	"w.edited": "· modificato",
	"w.pending": "In attesa di approvazione",
	"w.removed_by_mod": "[rimosso da un moderatore]",
	"w.deleted": "[eliminato]",
	"w.lowscore.hide": "Nascondi il commento",
	"w.lowscore.show": "Commento nascosto (punteggio basso) — mostra",
	"w.reply": "Rispondi",
	"w.edit": "Modifica",
	// "ancora 4m" — `{time}` arrives already formatted by Intl, unit included.
	// "ancora" is invariable, so the chip needs no plural agreement.
	"w.edit_left": "ancora {time}",
	"w.edit_last_minute": "meno di un minuto rimasto",
	"w.edit_expired": "Il tempo per modificare è scaduto.",
	"w.delete": "Elimina",
	"w.delete_confirm": "Eliminare questo commento?",
	"w.report": "Segnala",
	"w.reported": "Segnalato, grazie",

	// ── Votes and reactions ─────────────────────────────────────────────────
	"w.vote.up": "Vota a favore",
	"w.vote.down": "Vota contro",
	"w.page.helpful": "È stato utile?",
	"w.page.up": "Vota a favore di questa pagina",
	"w.page.down": "Vota contro questa pagina",
	"w.page.react_prompt": "Qual è la tua reazione?",
	"w.react.fire": "Geniale",
	"w.react.love": "Adoro",
	"w.react.wow": "Wow",
	"w.react.laugh": "Divertente",
	// "Hmm" and not "Mah": "Mah" is the idiomatic Italian interjection here, but
	// it carries open scepticism, which is the reading the English key's comment
	// explicitly rules out. "Hmm" reads the same way in Italian.
	"w.react.hmm": "Hmm",
	"w.react.cry": "Triste",

	// ── The thread ──────────────────────────────────────────────────────────
	"w.replies": { one: "{n} risposta", other: "{n} risposte" },
	"w.more_replies": {
		one: "Mostra {n} altra risposta",
		other: "Mostra {n} altre risposte",
	},
	"w.loading_comments": "Caricamento dei commenti",
	"w.permalink": "Permalink al commento di @{name}, {time}",
	"w.region": "Commenti",
	"w.empty.open": "Scrivi il primo commento.",
	"w.empty.closed": "Ancora nessun commento.",
	"w.closed.post": "I commenti sono chiusi per questo articolo.",
	// "discussione" is the reader-facing word for a thread; "thread" stays out of
	// the visible copy even though Italian developers use it.
	"w.closed.aged": "Questa discussione è stata chiusa ai nuovi commenti.",
	"w.closed.sunset": "I commenti sono terminati.",
	"w.closed.other": "I commenti sono chiusi.",
	"w.sort_by": "Ordina per {control}",
	"w.sort.new": "Recenti",
	// Two words on purpose: "Vecchi" is one word but reads pejorative next to
	// "Recenti", and "Meno recenti" is the pair Italian sort controls use.
	"w.sort.old": "Meno recenti",
	"w.sort.top": "Migliori",
	"w.subscribe": "Inviami un'email sui nuovi commenti di questo articolo",
	"w.subscribe.submit": "Iscriviti",
	"w.subscribe.done": "Controlla la tua email per confermare.",
	"w.subscribe.failed": "Iscrizione non riuscita. Riprova.",
	"w.subscribe.ratelimit": "Troppe richieste. Riprova più tardi.",
	"w.subscribe.awaiting": "Conferma l'email che ti abbiamo inviato, oppure premi per annullare",
	"w.unsubscribe": "Non inviarmi più email sui nuovi commenti di questo articolo",
	"w.unsubscribe.done": "Non riceverai più email su questa discussione.",
	"w.unsubscribe.failed": "Impossibile annullare l'iscrizione. Riprova.",
	"w.unsubscribe.row": "Annulla iscrizione",
	"w.manage": "Gestisci le iscrizioni",
	"w.manage.empty": "Non segui nessuna discussione.",
	"w.manage.failed": "Impossibile caricare le tue iscrizioni.",
	"w.load_more": "Carica i commenti precedenti",
	"w.load_more_failed": "Impossibile caricarne altri: {detail}",

	// ── Identity ────────────────────────────────────────────────────────────
	"w.posting_as": "Pubblichi come {name}",
	"w.sign_out": "Esci",
	"w.signin_prompt": "Accedi per ottenere un badge di verifica:",

	// ── Load failures ───────────────────────────────────────────────────────
	"w.err.transient":
		"I commenti non sono temporaneamente disponibili. Riprova tra qualche minuto.",
	"w.err.generic": "Impossibile caricare i commenti.",

	// ── Attribution ─────────────────────────────────────────────────────────
	// "Garrul" is a product name and stays untranslated inside {link}.
	"w.powered_by": "Con tecnologia di {link}",
} satisfies WidgetTable;
