/**
 * Portuguese server strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Covers the surfaces a reader sees: API error bodies (the widget renders them
 * verbatim), the subscription notices, email subjects and the Atom feed.
 *
 * `telegram.*` is deliberately absent. The bot talks to the operator of a
 * self-hosted install, not to readers, and it renders through the English
 * translator by design — see src/i18n/index.ts. Partial tables are the normal
 * case here: anything missing falls back to English per key.
 *
 * The tag is the bare primary subtag `pt`, not `pt-BR` or `pt-PT`, so one table
 * serves both variants: `pt-BR`, `pt-PT` and a bare `pt` all negotiate here.
 * The same conventions as src/i18n/widget/pt.ts, restated so a reviewer of
 * either variant can check this file on its own:
 *
 *   - **Brazilian form where the two genuinely diverge** (the larger audience):
 *     "Algo deu errado", "solicitação". Nothing Brazil-only-colloquial.
 *   - **Neutral wording wherever one exists that is idiomatic in both** —
 *     "publicação" (not "postagem"), "apagar" (not "excluir").
 *   - **"comentário"** for a comment and **"e-mail"** for email, throughout.
 *   - **Impersonal phrasing**, so an error body under someone else's blog post
 *     never has to choose between "você" and "tu". Imperatives take the
 *     você/formal form without the pronoun ("Recarregue", "Tente"), which is
 *     the polite default in Brazil and in Portugal alike.
 *   - **Curly double quotes** around `{title}` wherever English quotes it, the
 *     Brazilian typographic convention rather than the European guillemets.
 *     Where English leaves the title bare (the confirm subject, the feed title)
 *     this file does too — `es.ts` and `de.ts` make the same call.
 */
import type { LocaleTable } from "./index";

export const pt = {
	// Validation / API errors
	"err.body.required": "O texto do comentário é obrigatório.",
	"err.body.too_long": "O comentário é muito longo (máximo de {max} caracteres).",
	"err.post.required": "Falta o identificador da publicação.",
	"err.post.invalid": "Identificador de publicação inválido.",
	// "comentário respondido" rather than a literal "comentário pai": the parent
	// is only ever visible to the reader as the one being replied to.
	"err.parent.not_found": "O comentário respondido não foi encontrado.",
	"err.parent.different_post": "O comentário respondido pertence a outra publicação.",
	"err.parent.too_deep":
		"Este tópico está aninhado em excesso. Responda mais acima no tópico.",
	"err.name.required": "É necessário um nome de exibição.",
	"err.name.too_long": "O nome de exibição é muito longo (máximo de {max} caracteres).",
	"err.turnstile.required":
		"A verificação antispam falhou. Recarregue a página e tente novamente.",
	"err.turnstile.invalid":
		"A verificação antispam falhou. Recarregue a página e tente novamente.",
	"err.ratelimit": "Comentários em excesso — vá com calma e tente de novo em instantes.",
	"err.honeypot": "Comentário rejeitado.",
	"err.origin.forbidden": "Solicitação bloqueada: origem não permitida.",
	"err.session.expired": "A sessão expirou. Recarregue a página e tente novamente.",
	"err.edit.window_expired": "O prazo de edição terminou.",
	"err.edit.not_author": "Só é possível editar os próprios comentários.",
	"err.delete.not_author": "Só é possível apagar os próprios comentários.",
	"err.not_found": "Não encontrado.",
	"err.banned": "Esta conta está banida.",
	"err.thread_closed": "Os comentários estão fechados nesta publicação.",
	// Brazilian "deu errado", not European "correu mal".
	"err.internal": "Algo deu errado. Tente novamente.",

	// Server-rendered UI strings
	"ui.deleted": "[apagado]",
	"ui.subscribe.pending": "Verifique a caixa de entrada para confirmar a inscrição.",
	"ui.subscribe.confirmed": "Inscrição confirmada.",

	// Landing pages for the confirm/unsubscribe links in the email
	"ui.subscribe.link_expired": "O link expirou ou já foi usado.",
	"ui.subscribe.confirmed_page":
		"As notificações de comentários em “{title}” estão confirmadas.",
	"ui.subscribe.already_unsubscribed":
		"As notificações de comentários em “{title}” já foram canceladas.",
	"ui.subscribe.unsubscribed":
		"As notificações de comentários em “{title}” foram canceladas.",
	"ui.subscribe.unsubscribe_confirm":
		"Cancelar as notificações de comentários em “{title}”?",
	"ui.subscribe.unsubscribe_cta": "Sim, cancelar a inscrição",
	"ui.subscribe.unsubscribe_note":
		"Nada mudou ainda — a inscrição continua ativa até a confirmação.",
	// The rest of the same page: every other thread this address follows.
	"ui.subscribe.manage_others":
		"Este endereço também recebe notificações destes tópicos:",
	"ui.subscribe.unsubscribe_row_cta": "Cancelar inscrição",
	"ui.subscribe.unsubscribe_all_cta": "Cancelar a inscrição em todos os tópicos",
	"ui.subscribe.unsubscribed_all":
		"As notificações de comentários foram canceladas em todos os tópicos.",

	// Transactional email
	"email.confirm.subject": "Confirme a inscrição nos comentários de {title}",
	"email.confirm.heading": "Confirme a inscrição",
	"email.confirm.intro":
		"Foi solicitada uma inscrição nas notificações de respostas de {title}.",
	"email.confirm.ignore":
		"Caso a solicitação não tenha partido daqui, ignore este e-mail — sem o clique de confirmação abaixo, nenhuma outra mensagem sobre este tópico será enviada para este endereço.",
	"email.confirm.cta": "Confirmar inscrição",
	"email.confirm.paste": "Ou cole este link no navegador:",
	"email.digest.subject": "Novas respostas em “{title}”",
	// CLDR selects `one` for count=0 as well as count=1 in Portuguese, so the
	// singular wording has to read for both.
	"email.digest.heading": {
		one: "{count} novo comentário em “{title}”",
		other: "{count} novos comentários em “{title}”",
	},
	"email.digest.permalink": "link permanente",
	"email.digest.unsubscribe": "Cancelar as notificações deste tópico",

	// Atom feed
	"feed.title": "Comentários em {title}",
	"feed.entry_title": "{author} comentou",
} satisfies LocaleTable;
