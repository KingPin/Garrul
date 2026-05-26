import { escapeHtml } from "../escape";

/**
 * Domain dropdown shared by the admin queue, audit, and subscriptions
 * pages. Hosts come from `adminListHosts(db)` which already includes the
 * NO_URL_BUCKET sentinel when applicable; this widget just renders them.
 *
 * Every option value is HTML-escaped because hosts are derived from
 * `posts.url`, which originates with an embed installer and is therefore
 * untrusted text.
 */
export const renderHostFilter = (opts: {
	hosts: string[];
	selected: string;
}): string => {
	const optionFor = (value: string, label: string): string => {
		const isSelected = value === opts.selected;
		return `<option value="${escapeHtml(value)}"${isSelected ? " selected" : ""}>${escapeHtml(label)}</option>`;
	};
	const options = [
		optionFor("", "all domains"),
		...opts.hosts.map((h) => optionFor(h, h)),
	].join("");
	return `<select name="host" title="filter by domain">${options}</select>`;
};
