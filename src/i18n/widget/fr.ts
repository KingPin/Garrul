/**
 * French widget strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Register conventions this file commits to:
 *
 *   - **"vous"**, the default for a public-facing site addressing a reader it
 *     has no relationship with.
 *   - **French spacing.** A narrow no-break space belongs before `?`, `!`, `;`
 *     and `:` and inside `« »`. These strings use a normal space, which is what
 *     survives being copied through a plain-text table intact; a reviewer with a
 *     French keyboard is welcome to upgrade them.
 *   - French selects the `one` plural category for 0 as well as 1, so
 *     "0 réponse" is correct and handled by Intl.PluralRules, not by hand.
 *
 * See src/i18n/widget/index.ts: missing keys render English, so removing a bad
 * line here is a safe correction, not a regression.
 */
import type { WidgetTable } from "./index";

export const fr = {
	// ── Composer ────────────────────────────────────────────────────────────
	"w.toolbar": "Mise en forme",
	"w.md.bold": "Gras",
	"w.md.italic": "Italique",
	"w.md.link": "Lien",
	"w.md.code": "Code en ligne",
	"w.md.quote": "Citation",
	"w.md.list": "Liste à puces",
	"w.md.ph.bold": "gras",
	"w.md.ph.italic": "italique",
	"w.md.ph.link": "texte",
	"w.md.ph.code": "code",
	"w.tab.write": "Écrire",
	"w.tab.preview": "Aperçu",
	"w.md_hint": "La mise en forme Markdown est prise en charge",
	"w.preview.empty": "Rien à prévisualiser pour l'instant.",
	"w.preview.loading": "Chargement de l'aperçu…",
	"w.preview.failed": "Échec de l'aperçu. Réessayez.",
	"w.name_ph": "Votre nom",
	"w.body_ph": "Ajouter un commentaire…",
	// example.com is the RFC-2606 reserved example domain; a translated
	// lookalike would be somebody's real domain.
	"w.email_ph": "nom@example.com",
	"w.notify": "M'avertir par e-mail des nouveaux commentaires",
	"w.post_comment": "Publier le commentaire",
	"w.post_reply": "Publier la réponse",
	"w.reply_ph": "Répondre à @{name}…",
	"w.edit_ph": "Modifier votre commentaire…",
	"w.loading": "Chargement…",
	"w.save": "Enregistrer",
	"w.cancel": "Annuler",

	// ── Anti-spam ───────────────────────────────────────────────────────────
	"w.ts.title": "Vérification anti-spam",
	"w.ts.checking": "Vérification…",
	"w.ts.interactive": "Terminez la vérification anti-spam ci-dessus, puis publiez à nouveau.",
	"w.ts.timeout":
		"La vérification anti-spam ne s'est pas chargée. Vérifiez votre connexion ou rechargez la page.",
	"w.ts.retrying":
		"La vérification anti-spam a rencontré un problème et réessaie. Republiez dans un instant.",
	"w.ts.failed":
		"Échec du chargement de la vérification anti-spam. Rechargez la page ; si le problème persiste, le propriétaire du site devrait vérifier que https://challenges.cloudflare.com est accessible.",

	// ── A comment ───────────────────────────────────────────────────────────
	"w.verified": "vérifié",
	"w.edited": "· modifié",
	"w.pending": "En attente de validation",
	"w.removed_by_mod": "[supprimé par un modérateur]",
	"w.deleted": "[supprimé]",
	"w.lowscore.hide": "Masquer le commentaire",
	"w.lowscore.show": "Commentaire masqué (score faible) — afficher",
	"w.reply": "Répondre",
	"w.edit": "Modifier",
	"w.delete": "Supprimer",
	"w.delete_confirm": "Supprimer ce commentaire ?",
	"w.report": "Signaler",
	"w.reported": "Signalé, merci",

	// ── Votes and reactions ─────────────────────────────────────────────────
	"w.vote.up": "Voter pour",
	"w.vote.down": "Voter contre",
	"w.page.helpful": "Cette page vous a-t-elle été utile ?",
	"w.page.up": "Voter pour cette page",
	"w.page.down": "Voter contre cette page",
	"w.page.react_prompt": "Quelle est votre réaction ?",
	"w.react.fire": "Génial",
	"w.react.love": "J'adore",
	"w.react.wow": "Waouh",
	"w.react.laugh": "Drôle",
	"w.react.hmm": "Hmm",
	"w.react.cry": "Triste",

	// ── The thread ──────────────────────────────────────────────────────────
	"w.replies": { one: "{n} réponse", other: "{n} réponses" },
	"w.more_replies": {
		one: "Afficher {n} réponse de plus",
		other: "Afficher {n} réponses de plus",
	},
	"w.loading_comments": "Chargement des commentaires",
	"w.empty.open": "Soyez la première personne à commenter.",
	"w.empty.closed": "Aucun commentaire pour le moment.",
	"w.closed.post": "Les commentaires sont fermés pour cet article.",
	"w.closed.aged": "Ce fil a été fermé aux nouveaux commentaires.",
	"w.closed.sunset": "Les commentaires sont terminés.",
	"w.closed.other": "Les commentaires sont fermés.",
	"w.sort_by": "Trier par {control}",
	"w.sort.new": "Plus récents",
	"w.sort.top": "Meilleurs",
	"w.load_more": "Charger les commentaires plus anciens",
	"w.load_more_failed": "Impossible d'en charger davantage : {detail}",

	// ── Identity ────────────────────────────────────────────────────────────
	"w.posting_as": "Vous publiez en tant que {name}",
	"w.sign_out": "Se déconnecter",
	"w.signin_prompt": "Connectez-vous pour obtenir un badge vérifié :",

	// ── Load failures ───────────────────────────────────────────────────────
	"w.err.transient":
		"Les commentaires sont temporairement indisponibles. Revenez dans quelques minutes.",
	"w.err.generic": "Impossible de charger les commentaires.",

	// ── Attribution ─────────────────────────────────────────────────────────
	// "Garrul" is a product name and stays untranslated inside {link}.
	"w.powered_by": "Propulsé par {link}",
} satisfies WidgetTable;
