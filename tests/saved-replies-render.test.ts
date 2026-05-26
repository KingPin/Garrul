/**
 * Render-correctness tests for the saved-replies admin pages. Pure
 * string-template functions — no D1, no env.
 */
import { describe, it, expect } from "vitest";
import {
	renderSavedRepliesList,
	renderSavedReplyForm,
} from "../src/admin-ui/pages/saved-replies";
import type { SavedReply, User } from "../src/db/queries";

const mkUser = (over: Partial<User> = {}): User => ({
	id: "u_alice",
	provider: "github",
	provider_id: "1",
	name: "Alice",
	email: "a@example.com",
	avatar_url: null,
	is_admin: 0,
	role: "mod",
	is_banned: 0,
	created_at: 1_700_000_000_000,
	...over,
});

const mkReply = (over: Partial<SavedReply> = {}): SavedReply => ({
	id: "01HWH000000000000000000001",
	owner_id: "u_alice",
	title: "Welcome",
	body_md: "Hi there!",
	scope: "private",
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
	...over,
});

describe("renderSavedRepliesList", () => {
	it("shows the empty-state row", () => {
		const html = renderSavedRepliesList([], mkUser(), new Map());
		expect(html).toContain("No saved replies yet.");
	});

	it("shows 'you' for the viewer's own reply", () => {
		const html = renderSavedRepliesList(
			[mkReply()],
			mkUser(),
			new Map([["u_alice", "Alice"]]),
		);
		expect(html).toContain(">you<");
	});

	it("hides the Edit button for replies owned by someone else", () => {
		const html = renderSavedRepliesList(
			[mkReply({ owner_id: "u_bob", scope: "shared" })],
			mkUser(),
			new Map([["u_bob", "Bob"]]),
		);
		expect(html).toContain("read-only");
		expect(html).not.toMatch(/\/admin\/saved-replies\/01HWH/);
	});

	it("shows scope pills correctly", () => {
		const privateHtml = renderSavedRepliesList(
			[mkReply({ scope: "private" })],
			mkUser(),
			new Map(),
		);
		expect(privateHtml).toContain(">private<");

		const sharedHtml = renderSavedRepliesList(
			[mkReply({ scope: "shared" })],
			mkUser(),
			new Map(),
		);
		expect(sharedHtml).toContain(">shared<");
	});

	it("escapes a malicious title", () => {
		const html = renderSavedRepliesList(
			[mkReply({ title: "<img src=x onerror=alert(1)>" })],
			mkUser(),
			new Map([["u_alice", "Alice"]]),
		);
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img");
	});

	it("renders 'deleted user' when owner is unknown to the map", () => {
		const html = renderSavedRepliesList(
			[mkReply({ owner_id: "u_ghost", scope: "shared" })],
			mkUser(),
			new Map(),
		);
		expect(html).toContain("deleted user");
	});
});

describe("renderSavedReplyForm", () => {
	it("renders the new-reply form when existing is null", () => {
		const html = renderSavedReplyForm({ existing: null, error: null });
		expect(html).toContain("New saved reply");
		expect(html).toContain("method: 'POST'");
		expect(html).toContain("/admin/api/saved-replies");
		// No Delete button on create.
		expect(html).not.toContain("Delete saved reply");
	});

	it("renders the edit-reply form when existing is set", () => {
		const html = renderSavedReplyForm({ existing: mkReply(), error: null });
		expect(html).toContain("Edit saved reply");
		expect(html).toContain("method: 'PATCH'");
		expect(html).toContain("/admin/api/saved-replies/01HWH");
		expect(html).toContain("Delete saved reply");
	});

	it("escapes a malicious existing title in the input value", () => {
		const html = renderSavedReplyForm({
			existing: mkReply({ title: '" onload="alert(1)' }),
			error: null,
		});
		expect(html).not.toContain('" onload="alert(1)');
		expect(html).toContain("&quot;");
	});

	it("escapes a malicious body inside textarea", () => {
		const html = renderSavedReplyForm({
			existing: mkReply({ body_md: "</textarea><script>alert(1)</script>" }),
			error: null,
		});
		expect(html).not.toContain("</textarea><script>");
		expect(html).toContain("&lt;/textarea&gt;");
	});

	it("renders an error banner when error is set", () => {
		const html = renderSavedReplyForm({
			existing: null,
			error: "title_required",
		});
		expect(html).toContain("title_required");
		expect(html).toContain("Error:");
	});

	it("preselects the scope of the existing reply", () => {
		const sharedHtml = renderSavedReplyForm({
			existing: mkReply({ scope: "shared" }),
			error: null,
		});
		expect(sharedHtml).toMatch(/value="shared" selected/);

		const privateHtml = renderSavedReplyForm({
			existing: mkReply({ scope: "private" }),
			error: null,
		});
		expect(privateHtml).toMatch(/value="private" selected/);
	});
});
