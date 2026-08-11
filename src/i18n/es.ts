/**
 * Spanish server strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Covers the surfaces a reader sees: API error bodies (the widget renders them
 * verbatim), the subscription notices, email subjects and the Atom feed.
 *
 * `telegram.*` is deliberately absent — the bot is operator-facing and renders
 * through the English translator by design. Partial tables are the normal case:
 * anything missing falls back to English per key.
 *
 * Informal "tú" throughout, matching src/i18n/widget/es.ts.
 */
import type { LocaleTable } from "./index";

export const es = {
	// Validation / API errors
	"err.body.required": "El texto del comentario es obligatorio.",
	"err.body.too_long": "El comentario es demasiado largo (máximo {max} caracteres).",
	"err.post.required": "Falta el identificador de la entrada.",
	"err.post.invalid": "Identificador de entrada no válido.",
	"err.parent.not_found": "No se encontró el comentario al que respondes.",
	"err.parent.different_post": "El comentario al que respondes pertenece a otra entrada.",
	"err.parent.too_deep":
		"Este hilo está demasiado anidado. Responde más arriba en el hilo.",
	"err.name.required": "Es necesario un nombre visible.",
	"err.name.too_long": "El nombre visible es demasiado largo (máximo {max} caracteres).",
	"err.turnstile.required":
		"La comprobación antispam ha fallado. Recarga la página e inténtalo de nuevo.",
	"err.turnstile.invalid":
		"La comprobación antispam ha fallado. Recarga la página e inténtalo de nuevo.",
	"err.ratelimit": "Demasiados comentarios: espera un momento e inténtalo de nuevo.",
	"err.honeypot": "Comentario rechazado.",
	"err.origin.forbidden": "Solicitud bloqueada: origen no permitido.",
	"err.session.expired": "Tu sesión ha caducado. Recarga la página e inténtalo de nuevo.",
	"err.edit.window_expired": "El plazo de edición ha terminado.",
	"err.edit.not_author": "Solo puedes editar tus propios comentarios.",
	"err.delete.not_author": "Solo puedes eliminar tus propios comentarios.",
	"err.not_found": "No encontrado.",
	"err.banned": "Tu cuenta está bloqueada.",
	"err.thread_closed": "Los comentarios están cerrados en esta entrada.",
	"err.internal": "Algo ha salido mal. Inténtalo de nuevo.",

	// Server-rendered UI strings
	"ui.deleted": "[eliminado]",
	"ui.subscribe.pending": "Revisa tu correo para confirmar la suscripción.",
	"ui.subscribe.confirmed": "Suscripción confirmada.",

	// Transactional email
	"email.confirm.subject": "Confirma tu suscripción a los comentarios de {title}",
	"email.digest.subject": "Nuevas respuestas en «{title}»",

	// Atom feed
	"feed.title": "Comentarios en {title}",
	"feed.entry_title": "{author} ha comentado",
} satisfies LocaleTable;
