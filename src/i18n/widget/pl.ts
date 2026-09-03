/**
 * Polish widget strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Register conventions this file commits to, so a reviewer can check them at a
 * glance and a future contributor doesn't undo them:
 *
 *   - **Second-person-singular imperative for actions** — "Zapisz", "Anuluj",
 *     "Odpowiedz". It is what every Polish comment UI uses and it needs no
 *     pronoun.
 *   - **Impersonal phrasing for notices** — "Nie można załadować komentarzy.",
 *     not "Nie mogłeś…". A comment box under someone else's blog post has no
 *     basis for choosing between ty and Pan/Pani, so no notice states one.
 *   - No `ty`/`Twój` pronouns anywhere: the imperative already carries the
 *     address, and spelling it out would force the choice the rule avoids.
 *   - Polish runs longer than English, so the strings that sit in tight
 *     controls (the sort dropdown, Save/Cancel, the six-across reaction row)
 *     are kept to one short word.
 *
 * **Plurals need three forms here, not two.** `Intl.PluralRules("pl")` returns
 * `one` / `few` / `many` for the integers a comment count reaches, and never
 * `other` — a table filled in as `{one, other}` would render nothing for most
 * counts. Every plural key below carries `one`, `few` and `many`; `other`
 * covers fractional values only. Do not delete a form.
 *
 * See src/i18n/widget/index.ts: missing keys render English, so removing a bad
 * line here is a safe correction, not a regression.
 */
import type { WidgetTable } from "./index";

export const pl = {
	// ── Composer ────────────────────────────────────────────────────────────
	"w.toolbar": "Formatowanie",
	"w.md.bold": "Pogrubienie",
	"w.md.italic": "Kursywa",
	"w.md.link": "Link",
	"w.md.code": "Kod w tekście",
	"w.md.quote": "Cytat",
	"w.md.list": "Lista punktowana",
	"w.md.ph.bold": "pogrubienie",
	"w.md.ph.italic": "kursywa",
	"w.md.ph.link": "tekst",
	"w.md.ph.code": "kod",
	// Tab labels, so the imperative doubles as the shortest form available.
	"w.tab.write": "Pisz",
	"w.tab.preview": "Podgląd",
	"w.tab.list": "Tryb edycji",
	// "Markdown" is a proper noun and stays as is.
	"w.md_hint": "Obsługiwane jest formatowanie w Markdown",
	"w.kbd_hint": "⌘/Ctrl + Enter, aby opublikować",
	// Three forms, and the noun changes case with each: 1 znak, 2 znaki,
	// 5 znaków. `other` is reachable only for fractions, hence the genitive
	// singular there.
	"w.count_left": {
		one: "Pozostał {n} znak",
		few: "Pozostały {n} znaki",
		many: "Pozostało {n} znaków",
		other: "Pozostało {n} znaku",
	},
	"w.count_over": {
		one: "{n} znak ponad limit",
		few: "{n} znaki ponad limit",
		many: "{n} znaków ponad limit",
		other: "{n} znaku ponad limit",
	},
	"w.preview.empty": "Nie ma jeszcze nic do podglądu.",
	"w.preview.loading": "Wczytywanie podglądu…",
	"w.preview.failed": "Nie udało się wczytać podglądu. Spróbuj ponownie.",
	// No "Twoje" — the file's no-pronoun rule.
	"w.name_ph": "Imię lub nazwa",
	"w.body_ph": "Dodaj komentarz…",
	// example.com is the RFC-2606 reserved example domain; a translated
	// lookalike would be somebody's real domain.
	"w.email_ph": "adres@example.com",
	"w.email_label": "Adres e-mail",
	"w.notify": "Powiadamiaj e-mailem o nowych komentarzach",
	"w.post_comment": "Opublikuj komentarz",
	"w.post_reply": "Opublikuj odpowiedź",
	"w.reply_ph": "Odpowiedz @{name}…",
	"w.edit_ph": "Edytuj komentarz…",
	"w.loading": "Wczytywanie…",
	"w.save": "Zapisz",
	"w.cancel": "Anuluj",
	"w.posted": "Komentarz opublikowany",

	// ── Anti-spam ───────────────────────────────────────────────────────────
	"w.ts.title": "Kontrola antyspamowa",
	"w.ts.checking": "Sprawdzanie…",
	"w.ts.interactive": "Ukończ kontrolę antyspamową powyżej i opublikuj ponownie.",
	"w.ts.timeout":
		"Kontrola antyspamowa nie została wczytana. Sprawdź połączenie lub odśwież stronę.",
	"w.ts.retrying":
		"Kontrola antyspamowa napotkała problem i ponawia próbę. Opublikuj ponownie za chwilę.",
	"w.ts.failed":
		"Nie udało się wczytać kontroli antyspamowej. Odśwież stronę; jeśli błąd się powtarza, właściciel witryny powinien sprawdzić, czy adres https://challenges.cloudflare.com jest osiągalny.",

	// ── A comment ───────────────────────────────────────────────────────────
	"w.verified": "zweryfikowany",
	"w.edited": "· edytowany",
	"w.pending": "Oczekuje na zatwierdzenie",
	"w.removed_by_mod": "[usunięty przez moderatora]",
	"w.deleted": "[usunięty]",
	"w.lowscore.hide": "Ukryj komentarz",
	"w.lowscore.show": "Komentarz ukryty (niska ocena) — pokaż",
	"w.reply": "Odpowiedz",
	"w.edit": "Edytuj",
	// "pozostało: 4 min" — `{time}` arrives already formatted by Intl, unit
	// included. The colon construction is deliberate: Polish would otherwise
	// inflect the unit on the number inside the slot, which this file cannot see.
	"w.edit_left": "pozostało {time}",
	"w.edit_last_minute": "pozostało mniej niż minuta",
	"w.edit_expired": "Czas na edycję minął.",
	"w.delete": "Usuń",
	"w.delete_confirm": "Usunąć ten komentarz?",
	"w.report": "Zgłoś",
	"w.reported": "Zgłoszono, dzięki",

	// ── Votes and reactions ─────────────────────────────────────────────────
	"w.vote.up": "Oceń pozytywnie",
	"w.vote.down": "Oceń negatywnie",
	"w.page.helpful": "Czy to było pomocne?",
	"w.page.up": "Oceń tę stronę pozytywnie",
	"w.page.down": "Oceń tę stronę negatywnie",
	// English asks a question that needs a pronoun in Polish; the imperative
	// says the same thing and keeps the file pronoun-free.
	"w.page.react_prompt": "Zareaguj",
	"w.react.fire": "Genialne",
	"w.react.love": "Uwielbiam",
	"w.react.wow": "Wow",
	"w.react.laugh": "Zabawne",
	"w.react.hmm": "Hmm",
	"w.react.cry": "Smutne",

	// ── The thread ──────────────────────────────────────────────────────────
	// 1 odpowiedź / 2 odpowiedzi / 5 odpowiedzi — `few` and `many` share a form
	// for this noun, but both must stay: `many` is what 0 and 5–21 select.
	"w.replies": {
		one: "{n} odpowiedź",
		few: "{n} odpowiedzi",
		many: "{n} odpowiedzi",
		other: "{n} odpowiedzi",
	},
	"w.more_replies": {
		one: "Pokaż jeszcze {n} odpowiedź",
		few: "Pokaż jeszcze {n} odpowiedzi",
		many: "Pokaż jeszcze {n} odpowiedzi",
		other: "Pokaż jeszcze {n} odpowiedzi",
	},
	"w.loading_comments": "Wczytywanie komentarzy",
	"w.permalink": "Bezpośredni odnośnik do komentarza @{name}, {time}",
	"w.region": "Komentarze",
	"w.empty.open": "Skomentuj jako pierwszy.",
	"w.empty.closed": "Nie ma jeszcze komentarzy.",
	"w.closed.post": "Komentarze do tego wpisu są zamknięte.",
	"w.closed.aged": "Ten wątek został zamknięty dla nowych komentarzy.",
	"w.closed.sunset": "Komentowanie zostało zakończone.",
	"w.closed.other": "Komentarze są zamknięte.",
	"w.sort_by": "Sortuj według {control}",
	"w.sort.new": "Najnowsze",
	"w.sort.old": "Najstarsze",
	"w.sort.top": "Najlepsze",
	"w.subscribe": "Powiadamiaj e-mailem o nowych komentarzach do tego wpisu",
	"w.subscribe.submit": "Subskrybuj",
	"w.subscribe.done": "Sprawdź skrzynkę i potwierdź subskrypcję.",
	"w.subscribe.failed": "Nie udało się zapisać subskrypcji. Spróbuj ponownie.",
	"w.subscribe.ratelimit": "Zbyt wiele żądań. Spróbuj ponownie później.",
	"w.subscribe.awaiting": "Potwierdź wysłaną wiadomość lub naciśnij, aby anulować",
	"w.unsubscribe": "Przestań powiadamiać e-mailem o nowych komentarzach do tego wpisu",
	"w.unsubscribe.done": "Powiadomienia o tym wątku nie będą już wysyłane.",
	"w.unsubscribe.failed": "Nie udało się anulować subskrypcji. Spróbuj ponownie.",
	"w.unsubscribe.row": "Anuluj subskrypcję",
	"w.manage": "Zarządzaj subskrypcjami",
	"w.manage.empty": "Brak obserwowanych wątków.",
	"w.manage.failed": "Nie udało się wczytać subskrypcji.",
	"w.load_more": "Wczytaj starsze komentarze",
	"w.load_more_failed": "Nie udało się wczytać więcej: {detail}",

	// ── Identity ────────────────────────────────────────────────────────────
	"w.posting_as": "Publikowanie jako {name}",
	"w.sign_out": "Wyloguj",
	"w.signin_prompt": "Zaloguj się, aby otrzymać odznakę weryfikacji:",

	// ── Load failures ───────────────────────────────────────────────────────
	"w.err.transient":
		"Komentarze są chwilowo niedostępne. Sprawdź ponownie za kilka minut.",
	"w.err.generic": "Nie można załadować komentarzy.",

	// ── Attribution ─────────────────────────────────────────────────────────
	// "Garrul" is a product name and stays untranslated inside {link}.
	"w.powered_by": "Obsługiwane przez {link}",
} satisfies WidgetTable;
