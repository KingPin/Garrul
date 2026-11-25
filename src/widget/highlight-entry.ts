/**
 * IIFE entry for the lazily loaded highlighter bundle. The widget loader reads
 * window.__garrulHighlight after this script runs. This file holds the only
 * declaration of that global.
 */
import { highlight } from "./highlighter";

declare global {
	interface Window {
		__garrulHighlight?: (code: string, lang: string) => string | null;
	}
}

window.__garrulHighlight = highlight;
