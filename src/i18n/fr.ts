/**
 * French server strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Covers the surfaces a reader sees: API error bodies (the widget renders them
 * verbatim), the subscription notices, email subjects and the Atom feed.
 *
 * `telegram.*` is deliberately absent — the bot is operator-facing and renders
 * through the English translator by design. Partial tables are the normal case:
 * anything missing falls back to English per key.
 *
 * "vous" throughout, matching src/i18n/widget/fr.ts.
 */
import type { LocaleTable } from "./index";

export const fr = {
	// Validation / API errors
	"err.body.required": "Le texte du commentaire est obligatoire.",
	"err.body.too_long": "Le commentaire est trop long ({max} caractères maximum).",
	"err.post.required": "Identifiant d'article manquant.",
	"err.post.invalid": "Identifiant d'article invalide.",
	"err.parent.not_found": "Commentaire parent introuvable.",
	"err.parent.different_post": "Le commentaire parent appartient à un autre article.",
	"err.parent.too_deep": "Ce fil est trop imbriqué. Répondez plus haut dans le fil.",
	"err.name.required": "Un nom d'affichage est obligatoire.",
	"err.name.too_long": "Le nom d'affichage est trop long ({max} caractères maximum).",
	"err.turnstile.required":
		"Échec de la vérification anti-spam. Rechargez la page et réessayez.",
	"err.turnstile.invalid":
		"Échec de la vérification anti-spam. Rechargez la page et réessayez.",
	"err.ratelimit": "Trop de commentaires — ralentissez et réessayez dans un instant.",
	"err.honeypot": "Commentaire rejeté.",
	"err.origin.forbidden": "Requête bloquée : origine non autorisée.",
	"err.session.expired": "Votre session a expiré. Rechargez la page et réessayez.",
	"err.edit.window_expired": "Le délai de modification est écoulé.",
	"err.edit.not_author": "Vous ne pouvez modifier que vos propres commentaires.",
	"err.delete.not_author": "Vous ne pouvez supprimer que vos propres commentaires.",
	"err.not_found": "Introuvable.",
	"err.banned": "Votre compte est banni.",
	"err.thread_closed": "Les commentaires sont fermés pour cet article.",
	"err.internal": "Une erreur s'est produite. Réessayez.",

	// Server-rendered UI strings
	"ui.deleted": "[supprimé]",
	"ui.subscribe.pending": "Consultez votre boîte de réception pour confirmer votre abonnement.",
	"ui.subscribe.confirmed": "Abonnement confirmé.",

	// Transactional email
	"email.confirm.subject": "Confirmez votre abonnement aux commentaires de {title}",
	"email.digest.subject": "Nouvelles réponses sur « {title} »",

	// Atom feed
	"feed.title": "Commentaires sur {title}",
	"feed.entry_title": "{author} a commenté",
} satisfies LocaleTable;
