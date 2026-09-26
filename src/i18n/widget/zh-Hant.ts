/** Traditional Chinese widget strings. Machine-seeded; awaiting native-speaker review. */
import type { WidgetTable } from "./index";

/**
 * Traditional Chinese for Taiwan, Hong Kong and Macau. Keep this table in
 * Traditional Chinese characters; API error messages intentionally remain
 * English in the server table.
 */
export const zhHant = {
	// ── Composer ────────────────────────────────────────────────────────────
	"w.toolbar": "文字格式",
	"w.md.bold": "粗體",
	"w.md.italic": "斜體",
	"w.md.link": "連結",
	"w.md.code": "行內程式碼",
	"w.md.quote": "引用",
	"w.md.list": "項目符號清單",
	"w.md.ph.bold": "粗體",
	"w.md.ph.italic": "斜體",
	"w.md.ph.link": "文字",
	"w.md.ph.code": "程式碼",
	"w.tab.write": "撰寫",
	"w.tab.preview": "預覽",
	"w.tab.list": "編輯模式",
	"w.md_hint": "支援 Markdown 格式",
	"w.kbd_hint": "⌘/Ctrl + Enter 發佈",
	"w.count_left": { other: "還可輸入 {n} 個字元" },
	"w.count_over": { other: "超出上限 {n} 個字元" },
	"w.preview.empty": "目前沒有可預覽的內容。",
	"w.preview.loading": "正在載入預覽…",
	"w.preview.failed": "預覽失敗，請再試一次。",
	"w.name_ph": "名稱",
	"w.body_ph": "新增留言…",
	"w.email_ph": "you@example.com",
	"w.email_label": "電子郵件地址",
	"w.notify": "有新留言時以電子郵件通知我",
	"w.post_comment": "發佈留言",
	"w.post_reply": "發佈回覆",
	"w.reply_ph": "回覆 @{name}…",
	"w.edit_ph": "編輯留言…",
	"w.loading": "載入中…",
	"w.save": "儲存",
	"w.cancel": "取消",
	"w.posted": "留言已發佈",

	// ── Anti-spam ───────────────────────────────────────────────────────────
	"w.ts.title": "垃圾訊息防護檢查",
	"w.ts.checking": "檢查中…",
	"w.ts.interactive": "請完成上方的防垃圾訊息檢查，再重新發佈。",
	"w.ts.timeout": "防垃圾訊息檢查載入失敗。請檢查網路連線或重新載入頁面。",
	"w.ts.retrying": "防垃圾訊息檢查遇到問題，正在重試。請稍後再發佈。",
	"w.ts.failed":
		"防垃圾訊息檢查載入失敗。請重新載入頁面；若問題持續，請網站管理員確認 https://challenges.cloudflare.com 是否可連線。",

	// ── A comment ───────────────────────────────────────────────────────────
	"w.verified": "已驗證",
	"w.edited": "· 已編輯",
	"w.pending": "等待核准",
	"w.removed_by_mod": "[版主已移除此留言]",
	"w.deleted": "[已刪除]",
	"w.lowscore.hide": "隱藏留言",
	"w.lowscore.show": "留言因分數過低而隱藏 — 顯示",
	"w.reply": "回覆",
	"w.edit": "編輯",
	"w.edit_left": "剩餘 {time}",
	"w.edit_last_minute": "剩不到一分鐘",
	"w.edit_expired": "留言的編輯期限已過。",
	"w.delete": "刪除",
	"w.delete_confirm": "確定要刪除這則留言嗎？",
	"w.report": "檢舉",
	"w.reported": "已檢舉，謝謝",

	// ── Votes and reactions ─────────────────────────────────────────────────
	"w.vote.up": "支持",
	"w.vote.down": "反對",
	"w.page.helpful": "這篇內容有幫助嗎？",
	"w.page.up": "支持這篇內容",
	"w.page.down": "反對這篇內容",
	"w.page.react_prompt": "你有什麼感想？",
	"w.react.fire": "精彩",
	"w.react.love": "喜歡",
	"w.react.wow": "驚喜",
	"w.react.laugh": "好笑",
	"w.react.hmm": "思考",
	"w.react.cry": "難過",

	// ── The thread ──────────────────────────────────────────────────────────
	"w.replies": { other: "{n} 則回覆" },
	"w.more_replies": { other: "顯示另外 {n} 則回覆" },
	"w.loading_comments": "正在載入留言",
	"w.permalink": "@{name} 的留言永久連結，{time}",
	"w.region": "留言",
	"w.empty.open": "來發表第一則留言吧。",
	"w.empty.closed": "目前沒有留言。",
	"w.closed.post": "這篇文章已關閉留言。",
	"w.closed.aged": "此討論串已關閉，不再接受新留言。",
	"w.closed.sunset": "留言期限已結束。",
	"w.closed.other": "留言功能已關閉。",
	"w.sort_by": "依{control}排序",
	"w.sort.new": "最新",
	"w.sort.old": "最早",
	"w.sort.top": "熱門",
	"w.subscribe": "以電子郵件接收這篇文章的新留言",
	"w.subscribe.submit": "訂閱",
	"w.subscribe.done": "請查看電子郵件以確認訂閱。",
	"w.subscribe.failed": "無法訂閱，請再試一次。",
	"w.subscribe.ratelimit": "請求次數過多，請稍後再試。",
	"w.subscribe.awaiting": "請確認我們寄出的電子郵件，或按此取消",
	"w.unsubscribe": "停止以電子郵件接收這篇文章的新留言",
	"w.unsubscribe.done": "你將不再收到此討論串的電子郵件。",
	"w.unsubscribe.failed": "無法取消訂閱，請再試一次。",
	"w.unsubscribe.row": "取消訂閱",
	"w.manage": "管理訂閱",
	"w.manage.empty": "你尚未追蹤任何討論串。",
	"w.manage.failed": "無法載入你的訂閱。",
	"w.load_more": "載入較早的留言",
	"w.load_more_failed": "無法載入更多留言：{detail}",

	// ── Identity ────────────────────────────────────────────────────────────
	"w.posting_as": "以 {name} 的身分發佈",
	"w.sign_out": "登出",
	"w.signin_prompt": "登入以取得已驗證標章：",

	// ── Load failures ───────────────────────────────────────────────────────
	"w.err.transient": "留言暫時無法使用，請幾分鐘後再回來查看。",
	"w.err.generic": "無法載入留言。",

	// ── Attribution ─────────────────────────────────────────────────────────
	"w.powered_by": "由 {link} 提供",
} satisfies WidgetTable;
