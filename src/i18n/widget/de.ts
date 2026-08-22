/**
 * German widget strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Register conventions this file commits to, so a reviewer can check them at a
 * glance and a future contributor doesn't undo them:
 *
 *   - **No direct address.** English "Your name" / "Edit your comment" force a
 *     du/Sie choice that a comment box under someone else's blog post has no
 *     basis to make. Impersonal phrasing ("Name", "Kommentar bearbeiten…")
 *     sidesteps it, which is also what most German sites do.
 *   - **Nouns over verbs where German prefers them** — "Formatierung", not
 *     "Formatieren".
 *   - German runs roughly 30% longer than English, so the strings that sit in
 *     tight controls (buttons, the sort dropdown) are kept deliberately short.
 *
 * See src/i18n/widget/index.ts: missing keys render English, so removing a bad
 * line here is a safe correction, not a regression.
 */
import type { WidgetTable } from "./index";

export const de = {
	// ── Composer ────────────────────────────────────────────────────────────
	"w.toolbar": "Formatierung",
	"w.md.bold": "Fett",
	"w.md.italic": "Kursiv",
	"w.md.link": "Link",
	"w.md.code": "Inline-Code",
	"w.md.quote": "Zitat",
	"w.md.list": "Aufzählung",
	"w.md.ph.bold": "fett",
	"w.md.ph.italic": "kursiv",
	"w.md.ph.link": "Text",
	"w.md.ph.code": "Code",
	"w.tab.write": "Schreiben",
	"w.tab.preview": "Vorschau",
	"w.tab.list": "Editormodus",
	"w.md_hint": "Formatierung mit Markdown wird unterstützt",
	"w.preview.empty": "Noch nichts für die Vorschau.",
	"w.preview.loading": "Vorschau wird geladen…",
	"w.preview.failed": "Vorschau fehlgeschlagen. Bitte erneut versuchen.",
	"w.name_ph": "Name",
	"w.body_ph": "Kommentar schreiben…",
	// example.com is the RFC-2606 reserved example domain; a translated
	// lookalike would be somebody's real domain.
	"w.email_ph": "name@example.com",
	"w.notify": "Bei neuen Kommentaren benachrichtigen",
	"w.post_comment": "Kommentar posten",
	"w.post_reply": "Antwort posten",
	"w.reply_ph": "Antwort an @{name}…",
	"w.edit_ph": "Kommentar bearbeiten…",
	"w.loading": "Wird geladen…",
	"w.save": "Speichern",
	"w.cancel": "Abbrechen",

	// ── Anti-spam ───────────────────────────────────────────────────────────
	"w.ts.title": "Spam-Schutz",
	"w.ts.checking": "Wird geprüft…",
	"w.ts.interactive": "Bitte den Spam-Schutz oben abschließen und erneut posten.",
	"w.ts.timeout":
		"Der Spam-Schutz wurde nicht geladen. Bitte die Verbindung prüfen oder die Seite neu laden.",
	"w.ts.retrying":
		"Beim Spam-Schutz gab es ein Problem, ein neuer Versuch läuft. Bitte gleich noch einmal posten.",
	"w.ts.failed":
		"Der Spam-Schutz konnte nicht geladen werden. Bitte die Seite neu laden; falls es weiterhin fehlschlägt, sollte der Website-Betreiber prüfen, ob https://challenges.cloudflare.com erreichbar ist.",

	// ── A comment ───────────────────────────────────────────────────────────
	"w.verified": "verifiziert",
	"w.edited": "· bearbeitet",
	"w.pending": "Warten auf Freigabe",
	"w.removed_by_mod": "[von der Moderation entfernt]",
	"w.deleted": "[gelöscht]",
	"w.lowscore.hide": "Kommentar ausblenden",
	"w.lowscore.show": "Kommentar ausgeblendet (niedrige Bewertung) — anzeigen",
	"w.reply": "Antworten",
	"w.edit": "Bearbeiten",
	// "noch 4 Min." — `{time}` arrives already formatted by Intl, unit included.
	"w.edit_left": "noch {time}",
	"w.edit_last_minute": "weniger als eine Minute übrig",
	"w.delete": "Löschen",
	"w.delete_confirm": "Diesen Kommentar löschen?",
	"w.report": "Melden",
	"w.reported": "Gemeldet, danke",

	// ── Votes and reactions ─────────────────────────────────────────────────
	"w.vote.up": "Positiv bewerten",
	"w.vote.down": "Negativ bewerten",
	"w.page.helpful": "War das hilfreich?",
	"w.page.up": "Seite positiv bewerten",
	"w.page.down": "Seite negativ bewerten",
	"w.page.react_prompt": "Wie ist deine Reaktion?",
	"w.react.fire": "Genial",
	"w.react.love": "Liebe ich",
	"w.react.wow": "Wow",
	"w.react.laugh": "Lustig",
	"w.react.hmm": "Hmm",
	"w.react.cry": "Traurig",

	// ── The thread ──────────────────────────────────────────────────────────
	"w.replies": { one: "{n} Antwort", other: "{n} Antworten" },
	"w.more_replies": {
		one: "{n} weitere Antwort anzeigen",
		other: "{n} weitere Antworten anzeigen",
	},
	"w.loading_comments": "Kommentare werden geladen",
	// Infinitive, not "Schreib" — the file's no-direct-address rule, and this
	// was the one line that broke it with a du-imperative.
	"w.empty.open": "Den ersten Kommentar schreiben.",
	"w.empty.closed": "Noch keine Kommentare.",
	"w.closed.post": "Kommentare sind für diesen Beitrag geschlossen.",
	"w.closed.aged": "Dieser Thread wurde für neue Kommentare geschlossen.",
	"w.closed.sunset": "Die Kommentarfunktion wurde beendet.",
	"w.closed.other": "Kommentare sind geschlossen.",
	"w.sort_by": "Sortieren nach {control}",
	"w.sort.new": "Neueste",
	"w.sort.old": "Älteste",
	"w.sort.top": "Beste",
	"w.subscribe": "Bei neuen Kommentaren zu diesem Beitrag benachrichtigen",
	"w.subscribe.submit": "Abonnieren",
	"w.subscribe.done": "Bitte bestätige die E-Mail, die wir dir geschickt haben.",
	"w.subscribe.failed": "Abonnieren fehlgeschlagen. Bitte erneut versuchen.",
	"w.subscribe.ratelimit": "Zu viele Anfragen. Bitte später erneut versuchen.",
	"w.load_more": "Ältere Kommentare laden",
	"w.load_more_failed": "Konnte nicht mehr laden: {detail}",

	// ── Identity ────────────────────────────────────────────────────────────
	"w.posting_as": "Posten als {name}",
	"w.sign_out": "Abmelden",
	"w.signin_prompt": "Anmelden für ein Verifiziert-Abzeichen:",

	// ── Load failures ───────────────────────────────────────────────────────
	"w.err.transient":
		"Kommentare sind vorübergehend nicht verfügbar. Bitte in ein paar Minuten noch einmal vorbeischauen.",
	"w.err.generic": "Kommentare konnten nicht geladen werden.",

	// ── Attribution ─────────────────────────────────────────────────────────
	// "Garrul" is a product name and stays untranslated inside {link}.
	"w.powered_by": "Bereitgestellt von {link}",
} satisfies WidgetTable;
