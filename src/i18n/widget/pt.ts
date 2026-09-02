/**
 * Portuguese widget strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * The tag is the bare primary subtag `pt`, not `pt-BR` or `pt-PT`, so one table
 * serves both sides of the Atlantic: `pt-BR`, `pt-PT` and a bare `pt` all
 * negotiate to this file. That makes the variant policy part of the contract,
 * not a detail, so it is stated here for a reviewer of either variant:
 *
 *   - **Brazilian form where the two genuinely diverge**, because it is the
 *     larger audience — "Salvar" (not "Guardar"), "Carregando…"/"Publicando"
 *     gerunds (not "A carregar"/"A publicar"), "Gerenciar" (not "Gerir").
 *     Nothing Brazil-only-colloquial: no slang, no regional idiom.
 *   - **Neutral wording wherever one exists that is idiomatic in both** —
 *     "publicação" (not "postagem"), "Apagar" (not "Excluir"), "Pendente de
 *     aprovação" (not "Aguardando aprovação"), "Adorei" (not "Amei").
 *   - **"comentário"** for a comment and **"e-mail"** for email, throughout.
 *   - **Infinitives in buttons and controls** ("Salvar", "Cancelar",
 *     "Responder", "Editar", "Apagar") — the Brazilian UI convention, and the
 *     one convention this file holds to for every action label.
 *   - **Impersonal phrasing in notices**, so nothing has to pick between "você"
 *     and "tu". Where a sentence needs an imperative it takes the você/formal
 *     form without the pronoun ("Recarregue", "Tente"), which is the polite
 *     default in Brazil and in Portugal alike; the tu form ("recarrega") is
 *     effectively Portugal-only and is never used here.
 *
 * Portuguese runs longer than English, so the strings that sit in tight
 * controls (the sort dropdown, the six-across reaction row) are kept to one
 * short word.
 *
 * See src/i18n/widget/index.ts: missing keys render English, so removing a bad
 * line here is a safe correction, not a regression.
 */
import type { WidgetTable } from "./index";

export const pt = {
	// ── Composer ────────────────────────────────────────────────────────────
	"w.toolbar": "Formatação",
	"w.md.bold": "Negrito",
	"w.md.italic": "Itálico",
	// "Link" over the Portuguese "ligação": it is the term both variants
	// actually use for a hyperlink in a text editor, and it is one word.
	"w.md.link": "Link",
	"w.md.code": "Código em linha",
	"w.md.quote": "Citação",
	"w.md.list": "Lista com marcadores",
	"w.md.ph.bold": "negrito",
	"w.md.ph.italic": "itálico",
	"w.md.ph.link": "texto",
	"w.md.ph.code": "código",
	"w.tab.write": "Escrever",
	"w.tab.preview": "Pré-visualizar",
	"w.tab.list": "Modo de edição",
	// "Markdown" is a product name and stays untranslated.
	"w.md_hint": "A formatação com Markdown é suportada",
	"w.kbd_hint": "⌘/Ctrl + Enter para publicar",
	// CLDR selects `one` for n=0 as well as n=1 in Portuguese, so the singular
	// wording has to read for both: "0 caractere restante", "1 caractere
	// restante". That is the CLDR-correct rendering, not an oversight.
	"w.count_left": { one: "{n} caractere restante", other: "{n} caracteres restantes" },
	"w.count_over": {
		one: "{n} caractere acima do limite",
		other: "{n} caracteres acima do limite",
	},
	"w.preview.empty": "Ainda não há nada para pré-visualizar.",
	"w.preview.loading": "Carregando a pré-visualização…",
	"w.preview.failed": "Falha na pré-visualização. Tente novamente.",
	// "Nome" rather than "Seu nome": the possessive is the one place the two
	// variants split on the article ("Seu nome" / "O seu nome"), and a
	// placeholder loses nothing by dropping it.
	"w.name_ph": "Nome",
	"w.body_ph": "Adicione um comentário…",
	// example.com is the RFC-2606 reserved example domain; a translated
	// lookalike would be somebody's real domain.
	"w.email_ph": "nome@example.com",
	"w.email_label": "Endereço de e-mail",
	"w.notify": "Avisar por e-mail sobre novos comentários",
	"w.post_comment": "Publicar comentário",
	"w.post_reply": "Publicar resposta",
	"w.reply_ph": "Responder a @{name}…",
	"w.edit_ph": "Editar o comentário…",
	"w.loading": "Carregando…",
	// Brazilian "Salvar", not European "Guardar" — see the header.
	"w.save": "Salvar",
	"w.cancel": "Cancelar",
	"w.posted": "Comentário publicado",

	// ── Anti-spam ───────────────────────────────────────────────────────────
	"w.ts.title": "Verificação antispam",
	"w.ts.checking": "Verificando…",
	"w.ts.interactive": "Conclua a verificação antispam acima e publique novamente.",
	"w.ts.timeout":
		"A verificação antispam não carregou. Verifique a conexão ou recarregue a página.",
	"w.ts.retrying":
		"A verificação antispam teve um problema e está tentando de novo. Publique em instantes.",
	"w.ts.failed":
		"Não foi possível carregar a verificação antispam. Recarregue a página; se continuar falhando, o responsável pelo site deve verificar se https://challenges.cloudflare.com está acessível.",

	// ── A comment ───────────────────────────────────────────────────────────
	"w.verified": "verificado",
	"w.edited": "· editado",
	// "Pendente de aprovação" reads in both variants; "Aguardando aprovação" is
	// the Brazilian gerund and "A aguardar aprovação" the European one.
	"w.pending": "Pendente de aprovação",
	"w.removed_by_mod": "[removido por um moderador]",
	"w.deleted": "[apagado]",
	"w.lowscore.hide": "Ocultar comentário",
	"w.lowscore.show": "Comentário oculto (pontuação baixa) — mostrar",
	"w.reply": "Responder",
	"w.edit": "Editar",
	// "mais 4 min" — `{time}` arrives already formatted by Intl, unit included,
	// so only the surrounding word is translated. "mais" and not "resta"/
	// "restam": the verb would have to agree with a number this string cannot
	// see, and the German table solves it the same way ("noch {time}").
	"w.edit_left": "mais {time}",
	"w.edit_last_minute": "resta menos de um minuto",
	"w.edit_expired": "O prazo de edição terminou.",
	// "Apagar" over Brazilian "Excluir": idiomatic in both variants, where
	// "Excluir" reads as "exclude" in European Portuguese.
	"w.delete": "Apagar",
	"w.delete_confirm": "Apagar este comentário?",
	"w.report": "Denunciar",
	"w.reported": "Denunciado, obrigado",

	// ── Votes and reactions ─────────────────────────────────────────────────
	"w.vote.up": "Votar a favor",
	"w.vote.down": "Votar contra",
	"w.page.helpful": "Isto foi útil?",
	"w.page.up": "Votar a favor desta página",
	"w.page.down": "Votar contra esta página",
	"w.page.react_prompt": "Qual é a sua reação?",
	// One word each: these sit under an emoji in a six-across row.
	// "Adorei" rather than the Brazilian "Amei", which reads as overstated in
	// European Portuguese.
	"w.react.fire": "Genial",
	"w.react.love": "Adorei",
	"w.react.wow": "Uau",
	"w.react.laugh": "Engraçado",
	"w.react.hmm": "Hmm",
	"w.react.cry": "Triste",

	// ── The thread ──────────────────────────────────────────────────────────
	"w.replies": { one: "{n} resposta", other: "{n} respostas" },
	"w.more_replies": {
		one: "Mostrar mais {n} resposta",
		other: "Mostrar mais {n} respostas",
	},
	"w.loading_comments": "Carregando comentários",
	"w.permalink": "Link permanente para o comentário de @{name}, {time}",
	"w.region": "Comentários",
	// Impersonal, so the label does not have to gender the reader the way
	// "Seja o primeiro a comentar" would.
	"w.empty.open": "Escreva o primeiro comentário.",
	"w.empty.closed": "Ainda não há comentários.",
	"w.closed.post": "Os comentários estão fechados nesta publicação.",
	"w.closed.aged": "Este tópico foi fechado para novos comentários.",
	"w.closed.sunset": "Os comentários foram encerrados.",
	"w.closed.other": "Os comentários estão fechados.",
	"w.sort_by": "Ordenar por {control}",
	// One word each — these are the options of a narrow dropdown.
	"w.sort.new": "Recentes",
	"w.sort.old": "Antigos",
	"w.sort.top": "Melhores",
	"w.subscribe": "Avisar por e-mail sobre novos comentários nesta publicação",
	// "Inscrever-se"/"inscrição" is the subscription vocabulary this file holds
	// to, over Brazilian "assinatura" and European "subscrição".
	"w.subscribe.submit": "Inscrever-se",
	"w.subscribe.done": "Verifique o e-mail para confirmar.",
	"w.subscribe.failed": "Não foi possível concluir a inscrição. Tente novamente.",
	// Never "tente novamente" — a 429 retry cannot succeed.
	"w.subscribe.ratelimit": "Muitas solicitações. Tente mais tarde.",
	"w.subscribe.awaiting": "Confirme o e-mail enviado ou pressione para cancelar",
	"w.unsubscribe": "Parar de receber e-mails sobre novos comentários nesta publicação",
	"w.unsubscribe.done": "Não chegarão mais e-mails sobre este tópico.",
	"w.unsubscribe.failed": "Não foi possível cancelar a inscrição. Tente novamente.",
	"w.unsubscribe.row": "Cancelar inscrição",
	// Brazilian "Gerenciar", not European "Gerir" — see the header.
	"w.manage": "Gerenciar inscrições",
	"w.manage.empty": "Nenhum tópico seguido.",
	"w.manage.failed": "Não foi possível carregar as inscrições.",
	"w.load_more": "Carregar comentários anteriores",
	"w.load_more_failed": "Não foi possível carregar mais: {detail}",

	// ── Identity ────────────────────────────────────────────────────────────
	"w.posting_as": "Publicando como {name}",
	"w.sign_out": "Sair",
	"w.signin_prompt": "Entre para receber um selo de verificado:",

	// ── Load failures ───────────────────────────────────────────────────────
	"w.err.transient":
		"Os comentários estão temporariamente indisponíveis. Tente novamente em alguns minutos.",
	"w.err.generic": "Não foi possível carregar os comentários.",

	// ── Attribution ─────────────────────────────────────────────────────────
	// "Garrul" is a product name and stays untranslated inside {link}.
	"w.powered_by": "Com tecnologia de {link}",
} satisfies WidgetTable;
