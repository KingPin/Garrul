/**
 * Traditional Chinese server strings. Machine-seeded; awaiting native-speaker review.
 *
 * Reader-facing subscription pages, mail and feed entries are translated.
 * `err.*` is deliberately omitted so API errors continue to use the English
 * source strings. Telegram and admin surfaces are operator-facing and remain
 * English by design.
 */
import type { LocaleTable } from "./index";

export const zhHant = {
	// Server-rendered UI strings
	"ui.deleted": "[已刪除]",
	"ui.subscribe.pending": "請查看收件匣以確認訂閱。",
	"ui.subscribe.confirmed": "訂閱已確認。",

	// Subscription confirmation and unsubscribe pages
	"ui.subscribe.link_expired": "連結已過期或已使用。",
	"ui.subscribe.confirmed_page": "你已確認訂閱「{title}」的留言通知。",
	"ui.subscribe.already_unsubscribed": "你已取消訂閱「{title}」的留言通知。",
	"ui.subscribe.unsubscribed": "你已取消訂閱「{title}」的留言通知。",
	"ui.subscribe.unsubscribe_confirm": "要取消訂閱「{title}」的留言通知嗎？",
	"ui.subscribe.unsubscribe_cta": "是，取消訂閱",
	"ui.subscribe.unsubscribe_note": "尚未變更；確認前你仍會收到通知。",
	"ui.subscribe.confirm_prompt": "要開啟「{title}」的留言通知嗎？",
	"ui.subscribe.confirm_cta": "是，通知我",
	"ui.subscribe.confirm_note": "尚未變更；確認前你不會收到通知。",
	"ui.subscribe.manage_others": "此電子郵件地址也有訂閱以下討論串的通知：",
	"ui.subscribe.unsubscribe_row_cta": "取消訂閱",
	"ui.subscribe.unsubscribe_all_cta": "取消所有討論串的訂閱",
	"ui.subscribe.unsubscribed_all": "你已取消所有討論串的留言通知。",

	// Transactional email
	"email.confirm.subject": "請確認你對「{title}」留言的訂閱",
	"email.confirm.heading": "確認訂閱",
	"email.confirm.intro": "有人要求訂閱「{title}」的新留言通知，請確認此訂閱。",
	"email.confirm.ignore":
		"如果這不是你提出的要求，請忽略這封電子郵件。若未點擊下方的確認連結，我們不會再寄送此討論串的通知。",
	"email.confirm.cta": "確認訂閱",
	"email.confirm.paste": "或將此連結貼到瀏覽器中：",
	"email.digest.subject": "「{title}」有新留言",
	"email.digest.heading": { other: "「{title}」有 {count} 則新留言" },
	"email.digest.permalink": "永久連結",
	"email.digest.unsubscribe": "取消此討論串的訂閱",

	// Atom feed
	"feed.title": "「{title}」的留言",
	"feed.entry_title": "{author} 發表了留言",
} satisfies LocaleTable;
