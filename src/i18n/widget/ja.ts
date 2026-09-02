/**
 * Japanese widget strings. **Machine-seeded — not reviewed by a native speaker.**
 *
 * The first non-Latin-script locale in the repo, so the conventions it commits
 * to are written down here rather than left to the next contributor to guess:
 *
 *   - **Register: です・ます for sentences and notices, bare noun phrases for
 *     controls.** Buttons and labels are 保存 / キャンセル / 返信 / 編集 / 削除 —
 *     that is the Japanese UI convention, and it also keeps them inside the
 *     tight controls they sit in. No 尊敬語 or 謙譲語 escalation anywhere: a
 *     comment box under someone else's blog post has no standing to bow.
 *   - **No direct address.** Japanese drops the subject where English says
 *     "your", so "Your name" is 名前 and "Edit your comment…" is コメントを編集…,
 *     which sidesteps the あなた/ご自身 choice the same way de.ts sidesteps du/Sie.
 *   - **Typography: full-width 。、「」 with no space before or after, and no
 *     ASCII spaces between Japanese characters.** A Latin word sitting inside
 *     Japanese text (Markdown, Garrul, an email address, a URL) takes no
 *     surrounding spaces either.
 *   - **Japanese has exactly one plural category, `other`.** Every plural key
 *     below is `{ other: … }` with no `one` form — see the note at the first one.
 *   - Japanese is compact, so the sort labels, the composer buttons and the
 *     six reaction labels come out at two or three characters, which is what
 *     the six-across emoji row wants anyway.
 *
 * See src/i18n/widget/index.ts: missing keys render English, so removing a bad
 * line here is a safe correction, not a regression.
 */
import type { WidgetTable } from "./index";

export const ja = {
	// ── Composer ────────────────────────────────────────────────────────────
	"w.toolbar": "書式",
	"w.md.bold": "太字",
	"w.md.italic": "斜体",
	"w.md.link": "リンク",
	"w.md.code": "インラインコード",
	"w.md.quote": "引用",
	"w.md.list": "箇条書き",
	"w.md.ph.bold": "太字",
	"w.md.ph.italic": "斜体",
	"w.md.ph.link": "テキスト",
	"w.md.ph.code": "コード",
	// The tab pair is 入力/プレビュー, not 書く/プレビュー — 入力 is what Japanese
	// editors label the writing half of a write/preview toggle.
	"w.tab.write": "入力",
	"w.tab.preview": "プレビュー",
	"w.tab.list": "入力モード",
	// "Markdown" stays in Latin script: that is how Japanese developer sites
	// write it, and カタカナ transliteration would be harder to recognise.
	"w.md_hint": "Markdownによる書式設定に対応しています",
	"w.kbd_hint": "⌘/Ctrl + Enterで投稿",
	// Japanese selects only the `other` plural category, so these keys carry no
	// `one` form on purpose. Do not "fix" them by adding one — `Intl.PluralRules`
	// for ja never returns it, so the extra branch would be dead in every render.
	"w.count_left": { other: "残り{n}文字" },
	"w.count_over": { other: "制限を{n}文字超えています" },
	"w.preview.empty": "プレビューする内容がまだありません。",
	"w.preview.loading": "プレビューを読み込んでいます…",
	"w.preview.failed": "プレビューに失敗しました。もう一度お試しください。",
	"w.name_ph": "名前",
	"w.body_ph": "コメントを入力…",
	// example.com is the RFC-2606 reserved example domain; a localized
	// lookalike would be somebody's real domain.
	"w.email_ph": "you@example.com",
	"w.email_label": "メールアドレス",
	"w.notify": "新しいコメントをメールで受け取る",
	"w.post_comment": "コメントを投稿",
	"w.post_reply": "返信を投稿",
	// No さん after {name}: it is arbitrary user text and may already carry a
	// title, a handle or no personal name at all. に返信 works whatever it holds.
	"w.reply_ph": "@{name}に返信…",
	"w.edit_ph": "コメントを編集…",
	"w.loading": "読み込み中…",
	"w.save": "保存",
	"w.cancel": "キャンセル",
	"w.posted": "コメントを投稿しました",

	// ── Anti-spam ───────────────────────────────────────────────────────────
	"w.ts.title": "スパム対策チェック",
	"w.ts.checking": "確認中…",
	"w.ts.interactive": "上のスパム対策チェックを完了してから、もう一度投稿してください。",
	"w.ts.timeout":
		"スパム対策チェックを読み込めませんでした。接続を確認するか、ページを再読み込みしてください。",
	"w.ts.retrying":
		"スパム対策チェックで問題が発生し、再試行しています。少し待ってからもう一度投稿してください。",
	"w.ts.failed":
		"スパム対策チェックを読み込めませんでした。ページを再読み込みしてください。それでも失敗する場合は、サイト運営者がhttps://challenges.cloudflare.comに接続できるか確認してください。",

	// ── A comment ───────────────────────────────────────────────────────────
	"w.verified": "確認済み",
	"w.edited": "· 編集済み",
	"w.pending": "承認待ち",
	"w.removed_by_mod": "[モデレーターにより削除されました]",
	"w.deleted": "[削除済み]",
	"w.lowscore.hide": "コメントを非表示にする",
	"w.lowscore.show": "低評価のため非表示です — 表示する",
	"w.reply": "返信",
	"w.edit": "編集",
	// "残り4分" — `{time}` arrives already formatted by Intl, unit included, so
	// only 残り is translated here. Never add a 分 or 秒 of your own.
	"w.edit_left": "残り{time}",
	"w.edit_last_minute": "残り1分未満",
	"w.edit_expired": "編集できる時間が終了しました。",
	"w.delete": "削除",
	"w.delete_confirm": "このコメントを削除しますか？",
	"w.report": "報告",
	"w.reported": "報告しました。ありがとうございます",

	// ── Votes and reactions ─────────────────────────────────────────────────
	"w.vote.up": "高く評価",
	"w.vote.down": "低く評価",
	"w.page.helpful": "参考になりましたか？",
	"w.page.up": "このページを高く評価",
	"w.page.down": "このページを低く評価",
	"w.page.react_prompt": "どう思いましたか？",
	"w.react.fire": "最高",
	"w.react.love": "好き",
	"w.react.wow": "驚き",
	"w.react.laugh": "面白い",
	"w.react.hmm": "うーん",
	"w.react.cry": "悲しい",

	// ── The thread ──────────────────────────────────────────────────────────
	"w.replies": { other: "{n}件の返信" },
	"w.more_replies": { other: "さらに{n}件の返信を表示" },
	"w.loading_comments": "コメントを読み込んでいます",
	"w.permalink": "@{name}のコメントへのパーマリンク、{time}",
	"w.region": "コメント",
	"w.empty.open": "最初のコメントを投稿してみてください。",
	"w.empty.closed": "まだコメントはありません。",
	"w.closed.post": "この投稿へのコメントは締め切られています。",
	"w.closed.aged": "このスレッドは新しいコメントを受け付けていません。",
	"w.closed.sunset": "コメントの受付は終了しました。",
	"w.closed.other": "コメントは締め切られています。",
	// {control} is the <select> itself, so the sentence has to end after it in
	// Japanese word order — で並び替え reads correctly with the control in front.
	"w.sort_by": "{control}で並び替え",
	"w.sort.new": "新着",
	"w.sort.old": "古い順",
	"w.sort.top": "人気",
	"w.subscribe": "この投稿の新しいコメントをメールで受け取る",
	"w.subscribe.submit": "登録",
	"w.subscribe.done": "確認メールを送信しました。メールから登録を完了してください。",
	"w.subscribe.failed": "登録できませんでした。もう一度お試しください。",
	"w.subscribe.ratelimit": "リクエストが多すぎます。しばらくしてからお試しください。",
	"w.subscribe.awaiting": "送信した確認メールで登録を完了するか、押して取り消します",
	"w.unsubscribe": "この投稿の新しいコメントのメール通知を停止する",
	"w.unsubscribe.done": "このスレッドのメール通知を停止しました。",
	"w.unsubscribe.failed": "解除できませんでした。もう一度お試しください。",
	"w.unsubscribe.row": "解除",
	"w.manage": "通知の管理",
	"w.manage.empty": "フォロー中のスレッドはありません。",
	"w.manage.failed": "登録中のスレッドを読み込めませんでした。",
	"w.load_more": "以前のコメントを読み込む",
	"w.load_more_failed": "追加で読み込めませんでした：{detail}",

	// ── Identity ────────────────────────────────────────────────────────────
	"w.posting_as": "{name}として投稿します",
	"w.sign_out": "ログアウト",
	"w.signin_prompt": "ログインすると確認済みバッジが付きます：",

	// ── Load failures ───────────────────────────────────────────────────────
	"w.err.transient":
		"コメントは一時的に利用できません。数分後にもう一度ご覧ください。",
	"w.err.generic": "コメントを読み込めませんでした。",

	// ── Attribution ─────────────────────────────────────────────────────────
	// "Garrul" is a product name and stays untranslated inside {link}.
	"w.powered_by": "{link}を利用しています",
} satisfies WidgetTable;
