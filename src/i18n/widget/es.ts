/**
 * Spanish widget strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Register conventions this file commits to:
 *
 *   - **Informal "tú"**, which is the default register on consumer web in both
 *     Spain and Latin America and reads correctly under a personal blog post.
 *   - **Neutral vocabulary**, avoiding words that split regionally ("comentario",
 *     "entrada", "enlace" — not "post", "liga", "artículo").
 *   - Verb-first imperatives for actions ("Publicar comentario"), matching the
 *     convention in Spanish-language UI rather than transliterating English.
 *
 * See src/i18n/widget/index.ts: missing keys render English, so removing a bad
 * line here is a safe correction, not a regression.
 */
import type { WidgetTable } from "./index";

export const es = {
	// ── Composer ────────────────────────────────────────────────────────────
	"w.toolbar": "Formato",
	"w.md.bold": "Negrita",
	"w.md.italic": "Cursiva",
	"w.md.link": "Enlace",
	"w.md.code": "Código en línea",
	"w.md.quote": "Cita",
	"w.md.list": "Lista con viñetas",
	"w.md.ph.bold": "negrita",
	"w.md.ph.italic": "cursiva",
	"w.md.ph.link": "texto",
	"w.md.ph.code": "código",
	"w.tab.write": "Escribir",
	"w.tab.preview": "Vista previa",
	"w.md_hint": "Se admite el formato con Markdown",
	"w.preview.empty": "Todavía no hay nada que previsualizar.",
	"w.preview.loading": "Cargando la vista previa…",
	"w.preview.failed": "No se pudo generar la vista previa. Inténtalo de nuevo.",
	"w.name_ph": "Tu nombre",
	"w.body_ph": "Añade un comentario…",
	// example.com is the RFC-2606 reserved example domain; a translated
	// lookalike would be somebody's real domain.
	"w.email_ph": "nombre@example.com",
	"w.notify": "Avisarme por correo de nuevos comentarios",
	"w.post_comment": "Publicar comentario",
	"w.post_reply": "Publicar respuesta",
	"w.reply_ph": "Responder a @{name}…",
	"w.edit_ph": "Edita tu comentario…",
	"w.loading": "Cargando…",
	"w.save": "Guardar",
	"w.cancel": "Cancelar",

	// ── Anti-spam ───────────────────────────────────────────────────────────
	"w.ts.title": "Comprobación antispam",
	"w.ts.checking": "Comprobando…",
	"w.ts.interactive": "Completa la comprobación antispam de arriba y vuelve a publicar.",
	"w.ts.timeout":
		"La comprobación antispam no se cargó. Revisa tu conexión o recarga la página.",
	"w.ts.retrying":
		"La comprobación antispam ha tenido un problema y se está reintentando. Vuelve a publicar en un momento.",
	"w.ts.failed":
		"No se pudo cargar la comprobación antispam. Recarga la página; si sigue fallando, el propietario del sitio debería comprobar que https://challenges.cloudflare.com es accesible.",

	// ── A comment ───────────────────────────────────────────────────────────
	"w.verified": "verificado",
	"w.edited": "· editado",
	"w.pending": "Pendiente de aprobación",
	"w.removed_by_mod": "[eliminado por un moderador]",
	"w.deleted": "[eliminado]",
	"w.lowscore.hide": "Ocultar comentario",
	"w.lowscore.show": "Comentario oculto (puntuación baja) — mostrar",
	"w.reply": "Responder",
	"w.edit": "Editar",
	"w.delete": "Eliminar",
	"w.delete_confirm": "¿Eliminar este comentario?",
	"w.report": "Denunciar",
	"w.reported": "Denunciado, gracias",

	// ── Votes and reactions ─────────────────────────────────────────────────
	"w.vote.up": "Votar a favor",
	"w.vote.down": "Votar en contra",
	"w.page.helpful": "¿Te ha resultado útil?",
	"w.page.up": "Votar a favor de esta página",
	"w.page.down": "Votar en contra de esta página",
	"w.page.react_prompt": "¿Cuál es tu reacción?",
	"w.react.fire": "Brillante",
	"w.react.love": "Me encanta",
	"w.react.wow": "Vaya",
	"w.react.laugh": "Divertido",
	"w.react.hmm": "Mmm",
	"w.react.cry": "Triste",

	// ── The thread ──────────────────────────────────────────────────────────
	"w.replies": { one: "{n} respuesta", other: "{n} respuestas" },
	"w.more_replies": {
		one: "Mostrar {n} respuesta más",
		other: "Mostrar {n} respuestas más",
	},
	"w.loading_comments": "Cargando comentarios",
	"w.empty.open": "Sé la primera persona en comentar.",
	"w.empty.closed": "Aún no hay comentarios.",
	"w.closed.post": "Los comentarios están cerrados en esta entrada.",
	"w.closed.aged": "Este hilo se ha cerrado a nuevos comentarios.",
	"w.closed.sunset": "Los comentarios han finalizado.",
	"w.closed.other": "Los comentarios están cerrados.",
	"w.sort_by": "Ordenar por {control}",
	"w.sort.new": "Más recientes",
	"w.sort.top": "Mejores",
	"w.load_more": "Cargar comentarios anteriores",
	"w.load_more_failed": "No se pudieron cargar más: {detail}",

	// ── Identity ────────────────────────────────────────────────────────────
	"w.posting_as": "Publicas como {name}",
	"w.sign_out": "Cerrar sesión",
	"w.signin_prompt": "Inicia sesión para obtener una insignia de verificado:",

	// ── Load failures ───────────────────────────────────────────────────────
	"w.err.transient":
		"Los comentarios no están disponibles temporalmente. Vuelve a intentarlo en unos minutos.",
	"w.err.generic": "No se pudieron cargar los comentarios.",

	// ── Attribution ─────────────────────────────────────────────────────────
	// "Garrul" is a product name and stays untranslated inside {link}.
	"w.powered_by": "Con tecnología de {link}",
} satisfies WidgetTable;
