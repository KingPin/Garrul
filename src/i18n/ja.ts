/**
 * Japanese server strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * Covers the surfaces a reader sees: API error bodies (the widget renders them
 * verbatim), the subscription notices, email copy and the Atom feed.
 *
 * `telegram.*` is deliberately absent. The bot talks to the operator of a
 * self-hosted install, not to readers, and it renders through the English
 * translator by design — see src/i18n/index.ts. Partial tables are the normal
 * case here: anything missing falls back to English per key.
 *
 * Same conventions as src/i18n/widget/ja.ts, held across both files so a native
 * reviewer can check them once:
 *
 *   - **Register: です・ます for every sentence and notice, bare noun phrases
 *     for the handful of buttons (解除, 登録を確認する).** No 尊敬語 or 謙譲語
 *     escalation — an error body under someone else's blog post has no standing
 *     for it, and it is the same reason de.ts refuses to pick du or Sie.
 *   - **Typography: full-width 。、「」 with no space before or after, and no
 *     ASCII spaces between Japanese characters.** A Latin word inside Japanese
 *     text takes no surrounding spaces either.
 *   - **Japanese has one plural category, `other`.** `email.digest.heading` is
 *     `{ other: … }` with no `one` form — see the note on it.
 *   - `{title}` is an arbitrary post title, so it is wrapped in 「」 everywhere
 *     it appears in prose, including the keys where English uses no quotes. A
 *     bare title running into the next particle is unreadable in Japanese, and
 *     Japanese sites quote titles as a matter of course.
 */
import type { LocaleTable } from "./index";

export const ja = {
	// Validation / API errors
	"err.body.required": "コメント本文を入力してください。",
	"err.body.too_long": "コメントが長すぎます（最大{max}文字）。",
	"err.post.required": "投稿の識別子がありません。",
	"err.post.invalid": "投稿の識別子が正しくありません。",
	"err.parent.not_found": "返信先のコメントが見つかりません。",
	"err.parent.different_post": "返信先のコメントは別の投稿のものです。",
	"err.parent.too_deep":
		"このスレッドは階層が深すぎます。もう少し上の階層で返信してください。",
	"err.name.required": "表示名を入力してください。",
	"err.name.too_long": "表示名が長すぎます（最大{max}文字）。",
	"err.turnstile.required":
		"スパムチェックに失敗しました。ページを再読み込みしてもう一度お試しください。",
	"err.turnstile.invalid":
		"スパムチェックに失敗しました。ページを再読み込みしてもう一度お試しください。",
	"err.ratelimit": "コメントが多すぎます — 少し間をおいてからもう一度お試しください。",
	"err.honeypot": "コメントは拒否されました。",
	"err.origin.forbidden": "リクエストをブロックしました。許可されていないオリジンです。",
	"err.session.expired":
		"セッションの有効期限が切れました。ページを再読み込みしてもう一度お試しください。",
	"err.edit.window_expired": "編集できる時間が終了しました。",
	"err.edit.not_author": "編集できるのは自分のコメントだけです。",
	"err.delete.not_author": "削除できるのは自分のコメントだけです。",
	"err.not_found": "見つかりません。",
	"err.banned": "このアカウントは利用を停止されています。",
	"err.thread_closed": "この投稿へのコメントは締め切られています。",
	"err.internal": "問題が発生しました。もう一度お試しください。",

	// Server-rendered UI strings
	"ui.deleted": "[削除済み]",
	"ui.subscribe.pending": "受信トレイを確認して登録を完了してください。",
	"ui.subscribe.confirmed": "登録が完了しました。",

	// Landing pages for the confirm/unsubscribe links in the email
	"ui.subscribe.link_expired": "リンクの有効期限が切れているか、すでに使用されています。",
	"ui.subscribe.confirmed_page": "「{title}」のコメント通知の登録が完了しました。",
	"ui.subscribe.already_unsubscribed":
		"「{title}」のコメント通知はすでに解除されています。",
	"ui.subscribe.unsubscribed": "「{title}」のコメント通知を解除しました。",
	"ui.subscribe.unsubscribe_confirm": "「{title}」のコメント通知を解除しますか？",
	"ui.subscribe.unsubscribe_cta": "はい、解除します",
	"ui.subscribe.unsubscribe_note":
		"まだ何も変更されていません。確認するまで登録は続きます。",
	"ui.subscribe.manage_others": "このアドレスは次のスレッドの通知も受け取っています：",
	"ui.subscribe.unsubscribe_row_cta": "解除",
	"ui.subscribe.unsubscribe_all_cta": "すべてのスレッドの通知を解除",
	"ui.subscribe.unsubscribed_all": "すべてのスレッドのコメント通知を解除しました。",

	// Transactional email
	"email.confirm.subject": "「{title}」のコメント通知の登録を確認してください",
	"email.confirm.heading": "登録の確認",
	"email.confirm.intro": "「{title}」の返信通知の登録が申請されています。",
	"email.confirm.ignore":
		"心当たりがない場合は、このメールを無視してください。下の確認リンクをクリックしない限り、このスレッドについてこのアドレスにメールが届くことはありません。",
	"email.confirm.cta": "登録を確認する",
	"email.confirm.paste": "または次のリンクをブラウザーに貼り付けてください：",
	"email.digest.subject": "「{title}」に新しい返信があります",
	// Japanese selects only the `other` plural category, so this key carries no
	// `one` form on purpose. Do not "fix" it by adding one — `Intl.PluralRules`
	// for ja never returns it, so the extra branch would be dead in every render.
	"email.digest.heading": { other: "「{title}」に{count}件の新しいコメント" },
	"email.digest.permalink": "パーマリンク",
	"email.digest.unsubscribe": "このスレッドの通知を解除",

	// Atom feed
	"feed.title": "「{title}」へのコメント",
	"feed.entry_title": "{author}がコメントしました",
} satisfies LocaleTable;
