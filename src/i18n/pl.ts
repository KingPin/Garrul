/**
 * Polish server strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Covers the surfaces a reader sees: API error bodies (the widget renders them
 * verbatim), the subscription notices, email copy and the Atom feed.
 *
 * `telegram.*` is deliberately absent. The bot talks to the operator of a
 * self-hosted install, not to readers, and it renders through the English
 * translator by design — see src/i18n/index.ts. Partial tables are the normal
 * case here: anything missing falls back to English per key.
 *
 * Register, matching src/i18n/widget/pl.ts so both halves read as one voice:
 * second-person-singular imperative for actions ("Odśwież stronę i spróbuj
 * ponownie."), impersonal phrasing for notices ("Nie znaleziono.", "Można
 * edytować tylko własne komentarze."), and no ty/Twój pronouns — an error body
 * under someone else's blog post has no basis for choosing ty or Pan/Pani.
 *
 * **Plurals need three forms here, not two.** `Intl.PluralRules("pl")` returns
 * `one` / `few` / `many` for integer counts and never `other`, so a table
 * filled in as `{one, other}` would render nothing for most counts. The one
 * plural key below carries all three; `other` covers fractions only.
 */
import type { LocaleTable } from "./index";

export const pl = {
	// Validation / API errors
	"err.body.required": "Treść komentarza jest wymagana.",
	"err.body.too_long": "Komentarz jest za długi (maksymalnie {max} znaków).",
	"err.post.required": "Brak identyfikatora wpisu.",
	"err.post.invalid": "Nieprawidłowy identyfikator wpisu.",
	"err.parent.not_found": "Nie znaleziono komentarza nadrzędnego.",
	"err.parent.different_post": "Komentarz nadrzędny należy do innego wpisu.",
	"err.parent.too_deep":
		"Ten wątek jest zbyt głęboko zagnieżdżony. Odpowiedz wyżej w wątku.",
	"err.name.required": "Nazwa wyświetlana jest wymagana.",
	"err.name.too_long": "Nazwa wyświetlana jest za długa (maksymalnie {max} znaków).",
	"err.turnstile.required":
		"Kontrola antyspamowa nie powiodła się. Odśwież stronę i spróbuj ponownie.",
	"err.turnstile.invalid":
		"Kontrola antyspamowa nie powiodła się. Odśwież stronę i spróbuj ponownie.",
	"err.ratelimit": "Zbyt wiele komentarzy — zwolnij i spróbuj ponownie za chwilę.",
	"err.honeypot": "Komentarz odrzucony.",
	"err.origin.forbidden": "Żądanie zablokowane: niedozwolone źródło.",
	"err.session.expired": "Sesja wygasła. Odśwież stronę i spróbuj ponownie.",
	"err.edit.window_expired": "Czas na edycję minął.",
	"err.edit.not_author": "Można edytować tylko własne komentarze.",
	"err.delete.not_author": "Można usuwać tylko własne komentarze.",
	"err.not_found": "Nie znaleziono.",
	"err.banned": "To konto jest zablokowane.",
	"err.thread_closed": "Komentarze do tego wpisu są zamknięte.",
	"err.internal": "Coś poszło nie tak. Spróbuj ponownie.",

	// Server-rendered UI strings
	"ui.deleted": "[usunięty]",
	"ui.subscribe.pending": "Sprawdź skrzynkę, aby potwierdzić subskrypcję.",
	"ui.subscribe.confirmed": "Subskrypcja potwierdzona.",

	// Landing pages for the confirm/unsubscribe links in the email.
	// Polish quotation marks are „…” — the low opening mark is not a comma.
	"ui.subscribe.link_expired": "Odnośnik wygasł lub został już użyty.",
	"ui.subscribe.confirmed_page":
		"Powiadomienia o komentarzach do „{title}” są potwierdzone.",
	"ui.subscribe.already_unsubscribed":
		"Powiadomienia o komentarzach do „{title}” zostały już anulowane.",
	"ui.subscribe.unsubscribed":
		"Powiadomienia o komentarzach do „{title}” zostały anulowane.",
	"ui.subscribe.unsubscribe_confirm":
		"Anulować powiadomienia o komentarzach do „{title}”?",
	"ui.subscribe.unsubscribe_cta": "Tak, anuluj powiadomienia",
	"ui.subscribe.unsubscribe_note":
		"Nic się jeszcze nie zmieniło — subskrypcja trwa do momentu potwierdzenia.",
	"ui.subscribe.manage_others":
		"Ten adres otrzymuje też powiadomienia z tych wątków:",
	"ui.subscribe.unsubscribe_row_cta": "Anuluj subskrypcję",
	"ui.subscribe.unsubscribe_all_cta": "Anuluj subskrypcję wszystkich wątków",
	"ui.subscribe.unsubscribed_all":
		"Powiadomienia o komentarzach we wszystkich wątkach zostały anulowane.",

	// Transactional email
	"email.confirm.subject": "Potwierdź subskrypcję komentarzy do {title}",
	"email.confirm.heading": "Potwierdź subskrypcję",
	"email.confirm.intro":
		"Poproszono o potwierdzenie subskrypcji powiadomień o odpowiedziach dla {title}.",
	"email.confirm.ignore":
		"Jeśli to nie było zamierzone, zignoruj tę wiadomość — bez kliknięcia potwierdzenia poniżej na ten adres nie zostaną wysłane żadne kolejne wiadomości dotyczące tego wątku.",
	"email.confirm.cta": "Potwierdź subskrypcję",
	"email.confirm.paste": "Albo wklej ten odnośnik do przeglądarki:",
	"email.digest.subject": "Nowe odpowiedzi w wątku „{title}”",
	// 1 nowy komentarz / 2 nowe komentarze / 5 nowych komentarzy: the adjective
	// and the noun both change case per form, so none of the three is a copy of
	// another. `many` is what 0 and 5–21 select, so dropping it empties the
	// common case.
	"email.digest.heading": {
		one: "{count} nowy komentarz w wątku „{title}”",
		few: "{count} nowe komentarze w wątku „{title}”",
		many: "{count} nowych komentarzy w wątku „{title}”",
		other: "{count} nowego komentarza w wątku „{title}”",
	},
	"email.digest.permalink": "bezpośredni odnośnik",
	"email.digest.unsubscribe": "Anuluj subskrypcję tego wątku",

	// Atom feed
	"feed.title": "Komentarze do {title}",
	// Both genders are possible and the feed has no gender data, so the
	// bracketed feminine ending is the standard Polish hedge.
	"feed.entry_title": "{author} skomentował(a)",
} satisfies LocaleTable;
