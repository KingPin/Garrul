/**
 * German server strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Covers the surfaces a reader sees: API error bodies (the widget renders them
 * verbatim), the subscription notices, email subjects and the Atom feed.
 *
 * `telegram.*` is deliberately absent. The bot talks to the operator of a
 * self-hosted install, not to readers, and it renders through the English
 * translator by design — see src/i18n/index.ts. Partial tables are the normal
 * case here: anything missing falls back to English per key.
 *
 * Impersonal phrasing throughout, matching src/i18n/widget/de.ts — an error
 * body under someone else's blog post has no basis for choosing du or Sie.
 */
import type { LocaleTable } from "./index";

export const de = {
	// Validation / API errors
	"err.body.required": "Ein Kommentartext ist erforderlich.",
	"err.body.too_long": "Der Kommentar ist zu lang (maximal {max} Zeichen).",
	"err.post.required": "Beitragskennung fehlt.",
	"err.post.invalid": "Ungültige Beitragskennung.",
	"err.parent.not_found": "Übergeordneter Kommentar nicht gefunden.",
	"err.parent.different_post":
		"Der übergeordnete Kommentar gehört zu einem anderen Beitrag.",
	"err.parent.too_deep":
		"Dieser Thread ist zu tief verschachtelt. Bitte weiter oben im Thread antworten.",
	"err.name.required": "Ein Anzeigename ist erforderlich.",
	"err.name.too_long": "Der Anzeigename ist zu lang (maximal {max} Zeichen).",
	"err.turnstile.required": "Spam-Prüfung fehlgeschlagen. Bitte neu laden und erneut versuchen.",
	"err.turnstile.invalid": "Spam-Prüfung fehlgeschlagen. Bitte neu laden und erneut versuchen.",
	"err.ratelimit": "Zu viele Kommentare — bitte etwas langsamer und gleich noch einmal versuchen.",
	"err.honeypot": "Kommentar abgelehnt.",
	"err.origin.forbidden": "Anfrage blockiert: Herkunft nicht erlaubt.",
	"err.session.expired": "Die Sitzung ist abgelaufen. Bitte neu laden und erneut versuchen.",
	"err.edit.window_expired": "Die Bearbeitungsfrist ist abgelaufen.",
	"err.edit.not_author": "Es können nur eigene Kommentare bearbeitet werden.",
	"err.delete.not_author": "Es können nur eigene Kommentare gelöscht werden.",
	"err.not_found": "Nicht gefunden.",
	"err.banned": "Dieses Konto ist gesperrt.",
	"err.thread_closed": "Kommentare sind für diesen Beitrag geschlossen.",
	"err.internal": "Etwas ist schiefgelaufen. Bitte erneut versuchen.",

	// Server-rendered UI strings
	"ui.deleted": "[gelöscht]",
	"ui.subscribe.pending": "Bitte im Posteingang das Abo bestätigen.",
	"ui.subscribe.confirmed": "Abo bestätigt.",

	// Landing pages for the confirm/unsubscribe links in the email
	"ui.subscribe.link_expired": "Der Link ist abgelaufen oder wurde bereits verwendet.",
	"ui.subscribe.confirmed_page":
		"Benachrichtigungen zu Kommentaren bei „{title}“ sind jetzt bestätigt.",
	"ui.subscribe.already_unsubscribed":
		"Benachrichtigungen zu Kommentaren bei „{title}“ wurden bereits abbestellt.",
	"ui.subscribe.unsubscribed":
		"Benachrichtigungen zu Kommentaren bei „{title}“ wurden abbestellt.",
	"ui.subscribe.unsubscribe_confirm":
		"Benachrichtigungen zu Kommentaren bei „{title}“ abbestellen?",
	"ui.subscribe.unsubscribe_cta": "Ja, abbestellen",
	"ui.subscribe.unsubscribe_note":
		"Es hat sich noch nichts geändert — das Abo bleibt bis zur Bestätigung bestehen.",
	"ui.subscribe.confirm_prompt":
		"Benachrichtigungen zu Kommentaren bei „{title}“ aktivieren?",
	"ui.subscribe.confirm_cta": "Ja, benachrichtigen",
	"ui.subscribe.confirm_note":
		"Es hat sich noch nichts geändert — Benachrichtigungen kommen erst nach der Bestätigung.",

	// Transactional email
	"email.confirm.subject": "Abo für Kommentare zu {title} bestätigen",
	"email.confirm.heading": "Abo bestätigen",
	"email.confirm.intro":
		"Für {title} wurde ein Abo für Antwortbenachrichtigungen angefragt.",
	"email.confirm.ignore":
		"Falls diese Anfrage nicht beabsichtigt war, kann diese E-Mail ignoriert werden — ohne Klick auf die Bestätigung unten werden keine weiteren Nachrichten zu diesem Thread an diese Adresse gesendet.",
	"email.confirm.cta": "Abo bestätigen",
	"email.confirm.paste": "Oder diesen Link im Browser öffnen:",
	"email.digest.subject": "Neue Antworten zu „{title}“",
	"email.digest.heading": {
		one: "{count} neuer Kommentar zu „{title}“",
		other: "{count} neue Kommentare zu „{title}“",
	},
	"email.digest.permalink": "Permalink",
	"email.digest.unsubscribe": "Benachrichtigungen zu diesem Thread abbestellen",

	// Atom feed
	"feed.title": "Kommentare zu {title}",
	"feed.entry_title": "{author} hat kommentiert",
} satisfies LocaleTable;
