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

	// Landing pages for the confirm/unsubscribe links in the email
	"ui.subscribe.link_expired": "El enlace ha caducado o ya se ha usado.",
	"ui.subscribe.confirmed_page":
		"Has confirmado las notificaciones de comentarios en «{title}».",
	"ui.subscribe.already_unsubscribed":
		"Ya has cancelado las notificaciones de comentarios de «{title}».",
	"ui.subscribe.unsubscribed":
		"Has cancelado las notificaciones de comentarios de «{title}».",
	"ui.subscribe.unsubscribe_confirm":
		"¿Cancelar las notificaciones de comentarios de «{title}»?",
	"ui.subscribe.unsubscribe_cta": "Sí, cancelar la suscripción",
	"ui.subscribe.unsubscribe_note":
		"Todavía no ha cambiado nada: sigues suscrito hasta que lo confirmes.",

	// Transactional email
	"email.confirm.subject": "Confirma tu suscripción a los comentarios de {title}",
	"email.confirm.heading": "Confirma tu suscripción",
	"email.confirm.intro":
		"Se ha solicitado una suscripción a las notificaciones de respuestas de {title}.",
	"email.confirm.ignore":
		"Si no has sido tú, ignora este correo: sin el clic de confirmación de abajo no se enviará ningún otro mensaje a esta dirección para este hilo.",
	"email.confirm.cta": "Confirmar suscripción",
	"email.confirm.paste": "O pega este enlace en tu navegador:",
	"email.digest.subject": "Nuevas respuestas en «{title}»",
	"email.digest.heading": {
		one: "{count} comentario nuevo en «{title}»",
		other: "{count} comentarios nuevos en «{title}»",
	},
	"email.digest.permalink": "enlace permanente",
	"email.digest.unsubscribe": "Cancelar las notificaciones de este hilo",

	// Atom feed
	"feed.title": "Comentarios en {title}",
	"feed.entry_title": "{author} ha comentado",
} satisfies LocaleTable;
