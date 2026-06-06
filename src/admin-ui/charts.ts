import type { TimelinePoint } from "../db/queries";
import { escapeHtml } from "./escape";

// Server-rendered inline SVG charts. No JS charting library and no external
// origin, so the strict admin CSP is unaffected. Colors use CSS variables so
// charts re-theme with light/dark automatically.

/**
 * A compact line sparkline. Kept for callers that want the minimal one-line
 * form; the dashboard uses {@link barChartSvg} for the main timeline.
 */
export const sparklineSvg = (points: TimelinePoint[]): string => {
	if (points.length === 0)
		return '<div class="muted">No activity in this range.</div>';
	const w = 320;
	const h = 60;
	const pad = 4;
	const max = Math.max(1, ...points.map((p) => p.count));
	const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
	const coords = points.map((p, i) => {
		const x = pad + i * step;
		const y = h - pad - ((h - pad * 2) * p.count) / max;
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	const path = `M ${coords.join(" L ")}`;
	const last = points[points.length - 1];
	const first = points[0];
	return `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"
     aria-label="Comments per day sparkline">
  <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <title>${points.length} days · peak ${max}/day</title>
</svg>
<div class="muted" style="font-size:0.75rem">
  ${escapeHtml(first?.day ?? "")} → ${escapeHtml(last?.day ?? "")} · peak ${max}/day
</div>`;
};

/**
 * A responsive bar chart of comments per day. The SVG fills its container
 * width (`preserveAspectRatio="none"`); each bar carries a `<title>` for a
 * native hover tooltip. Axis labels live in the HTML caption below, not inside
 * the stretched SVG, so text never distorts.
 */
export const barChartSvg = (points: TimelinePoint[]): string => {
	if (points.length === 0)
		return '<div class="muted">No activity in this range.</div>';
	const h = 120;
	const pad = 6;
	const gap = 2;
	const barW = 10;
	const n = points.length;
	const max = Math.max(1, ...points.map((p) => p.count));
	const innerH = h - pad * 2;
	const w = n * barW + (n - 1) * gap;
	const bars = points
		.map((p, i) => {
			const bh = (innerH * p.count) / max;
			const x = i * (barW + gap);
			const y = h - pad - bh;
			// Keep a 1px stub for zero days so the baseline reads as data, not a gap.
			const drawn = p.count > 0 ? Math.max(2, bh) : 1;
			return `<rect x="${x.toFixed(1)}" y="${(h - pad - drawn).toFixed(1)}" width="${barW}" height="${drawn.toFixed(1)}" rx="1.5" fill="var(--accent)"${p.count === 0 ? ' opacity="0.25"' : ""}><title>${escapeHtml(p.day)} · ${p.count}</title></rect>`;
		})
		.join("");
	const midY = pad + innerH / 2;
	const first = points[0];
	const last = points[points.length - 1];
	return `
<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Comments per day bar chart">
  <line x1="0" y1="${midY}" x2="${w}" y2="${midY}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 3"/>
  <line x1="0" y1="${h - pad}" x2="${w}" y2="${h - pad}" stroke="var(--border)" stroke-width="1"/>
  ${bars}
</svg>
<div class="muted" style="font-size:0.75rem;margin-top:0.35rem">
  ${escapeHtml(first?.day ?? "")} → ${escapeHtml(last?.day ?? "")} · peak ${max}/day
</div>`;
};
