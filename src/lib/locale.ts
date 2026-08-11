/**
 * Per-request locale.
 *
 * Resolves the locale once per request and stashes both it and a bound
 * translator on the Hono context. Handlers do `const t = c.get("t")` — a local
 * that shadows the module-level English `t` import, so migrating a route is
 * one added line rather than an edit per call site.
 *
 * The translator lives on the context rather than in module state because a
 * single Worker isolate serves concurrent requests; see src/i18n/index.ts.
 */
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../index";
import { type Translator, tFor } from "../i18n";
import { resolveLocale } from "../i18n/negotiate";

export type LocaleVars = {
	locale: string;
	t: Translator;
};

/**
 * Explicit choice: `data-lang` on the mount element, or the iframe route's
 * `?lang=`. Wins over everything.
 */
const EXPLICIT_PARAM = "lang";

/**
 * The host page's `<html lang>`, forwarded by the widget as a *hint*.
 *
 * Kept separate from `lang` so the server can tell an operator's deliberate
 * choice from an inferred one — machine-seeded locales are reachable only
 * through the explicit param, and that distinction is lost if both arrive
 * under the same name.
 */
const HINT_PARAM = "hl";

export const localeMiddleware = (): MiddlewareHandler<{
	Bindings: Bindings;
	Variables: LocaleVars;
}> => {
	return async (c, next) => {
		const locale = resolveLocale({
			requested: c.req.query(EXPLICIT_PARAM),
			hostPage: c.req.query(HINT_PARAM),
		});
		c.set("locale", locale);
		c.set("t", tFor(locale));
		await next();
	};
};
