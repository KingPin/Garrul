/**
 * Render-correctness tests for the webhooks admin pages. Pure
 * string-template functions — no D1, no env. Anything HTML-escape-
 * adjacent here is user-visible.
 */
import { describe, it, expect } from "vitest";
import {
	renderWebhooksList,
	renderWebhookForm,
} from "../src/admin-ui/pages/webhooks";
import type { WebhookEndpoint } from "../src/db/queries";

const makeEndpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
	id: "01HWH000000000000000000001",
	url: "https://example.com/hook",
	secret: "whsec_test_test_test_test",
	events: null,
	adapter: "generic",
	enabled: true,
	fail_count: 0,
	disabled_at: null,
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
	...over,
});

describe("renderWebhooksList", () => {
	it("shows the empty-state row when there are no endpoints", () => {
		const html = renderWebhooksList([], { active: false, url: "" });
		expect(html).toContain("No webhook endpoints configured");
	});

	it("renders signed pill for an endpoint with a secret", () => {
		const html = renderWebhooksList([makeEndpoint()], {
			active: false,
			url: "",
		});
		expect(html).toContain("pill approved");
		expect(html).toContain(">signed<");
	});

	it("renders unsigned pill for an endpoint without a secret", () => {
		const html = renderWebhooksList(
			[makeEndpoint({ secret: null })],
			{ active: false, url: "" },
		);
		expect(html).toContain(">unsigned<");
	});

	it("shows the env-shim warning only when active is true", () => {
		const off = renderWebhooksList([], { active: false, url: "" });
		expect(off).not.toContain("Legacy <code>WEBHOOK_URL</code>");

		const on = renderWebhooksList([], {
			active: true,
			url: "https://example.com/legacy",
		});
		expect(on).toContain("Legacy <code>WEBHOOK_URL</code>");
		expect(on).toContain("https://example.com/legacy");
	});

	it("escapes a malicious URL in the env-shim banner", () => {
		const html = renderWebhooksList([], {
			active: true,
			url: 'https://x" onload="alert(1)',
		});
		expect(html).not.toContain('" onload="alert(1)');
		expect(html).toContain("&quot;");
	});

	it("escapes a malicious URL in an endpoint row", () => {
		const html = renderWebhooksList(
			[makeEndpoint({ url: '<img src=x onerror=alert(1)>' })],
			{ active: false, url: "" },
		);
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});

	it("renders the auto-paused note when disabled_at is set", () => {
		const html = renderWebhooksList(
			[
				makeEndpoint({
					enabled: false,
					disabled_at: 1_700_000_500_000,
					fail_count: 10,
				}),
			],
			{ active: false, url: "" },
		);
		expect(html).toContain("auto-paused");
		expect(html).toContain("after 10 fails");
	});

	it("lists each subscribed event when events is non-null", () => {
		const html = renderWebhooksList(
			[makeEndpoint({ events: ["comment.posted", "comment.spam"] })],
			{ active: false, url: "" },
		);
		expect(html).toContain("comment.posted, comment.spam");
	});

	it("shows 'all events' label when events is null", () => {
		const html = renderWebhooksList(
			[makeEndpoint({ events: null })],
			{ active: false, url: "" },
		);
		expect(html).toContain("all events");
	});
});

describe("renderWebhookForm", () => {
	it("uses the create action and POST when endpoint is null", () => {
		const html = renderWebhookForm({ endpoint: null, error: null });
		expect(html).toContain(">Add webhook endpoint<");
		// x-data attribute is HTML-escaped, so literal quotes become &quot;.
		expect(html).toContain("&quot;/admin/api/webhooks&quot;");
		expect(html).toContain("&quot;POST&quot;");
		expect(html).toContain(">Create endpoint<");
	});

	it("uses the patch action and PATCH when endpoint is provided", () => {
		const e = makeEndpoint();
		const html = renderWebhookForm({ endpoint: e, error: null });
		expect(html).toContain(">Edit webhook endpoint<");
		expect(html).toContain(`/admin/api/webhooks/${e.id}`);
		expect(html).toContain("&quot;PATCH&quot;");
		expect(html).toContain(">Save changes<");
	});

	it("prefills the URL and secret in edit mode", () => {
		const e = makeEndpoint({
			url: "https://example.org/h",
			secret: "whsec_abcdef0123456789",
		});
		const html = renderWebhookForm({ endpoint: e, error: null });
		expect(html).toContain('value="https://example.org/h"');
		expect(html).toContain('value="whsec_abcdef0123456789"');
	});

	it("renders all five known events as checkboxes", () => {
		const html = renderWebhookForm({ endpoint: null, error: null });
		for (const ev of [
			"comment.posted",
			"comment.edited",
			"comment.deleted",
			"comment.approved",
			"comment.spam",
		]) {
			expect(html).toContain(`name="event_${ev}"`);
		}
	});

	it("checks every event by default in new mode", () => {
		const html = renderWebhookForm({ endpoint: null, error: null });
		// Five checkboxes, all checked.
		const checkedCount = (html.match(/type="checkbox" name="event_/g) ?? [])
			.length;
		const checkedAttrCount = (
			html.match(/type="checkbox" name="event_[^"]+" checked/g) ?? []
		).length;
		expect(checkedCount).toBe(5);
		expect(checkedAttrCount).toBe(5);
	});

	it("checks only the selected events in edit mode", () => {
		const e = makeEndpoint({ events: ["comment.posted", "comment.spam"] });
		const html = renderWebhookForm({ endpoint: e, error: null });
		expect(html).toContain('name="event_comment.posted" checked');
		expect(html).toContain('name="event_comment.spam" checked');
		expect(html).not.toContain('name="event_comment.edited" checked');
		expect(html).not.toContain('name="event_comment.deleted" checked');
		expect(html).not.toContain('name="event_comment.approved" checked');
	});

	it("renders the error block when supplied", () => {
		const html = renderWebhookForm({
			endpoint: null,
			error: "url:private_ipv4",
		});
		expect(html).toContain("url:private_ipv4");
	});

	it("escapes a malicious error message", () => {
		const html = renderWebhookForm({
			endpoint: null,
			error: '<img src=x onerror=alert(1)>',
		});
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});

	it("shows the adapter options and pre-selects the saved one", () => {
		const html = renderWebhookForm({
			endpoint: makeEndpoint({ adapter: "discord" }),
			error: null,
		});
		expect(html).toContain('value="generic"');
		expect(html).toContain('value="slack"');
		expect(html).toContain('value="discord" selected');
	});
});
