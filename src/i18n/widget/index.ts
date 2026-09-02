/**
 * Widget string tables, keyed by locale.
 *
 * Separate from the server tables in `src/i18n/en.ts` because the two surfaces
 * have nothing in common: the server's strings are API error bodies and email
 * copy, the widget's are buttons and placeholders a reader sees. Splitting them
 * also keeps the wire payload honest — `/api/v1/config` ships one of these
 * tables to the browser, and only this one.
 *
 * English is deliberately absent. `EN` is compiled into the bundle, so an
 * English reader downloads no table at all, and every other locale is looked up
 * per key with an English fallback (see `makeS`) — which is what lets a partial
 * translation ship instead of blocking a locale until it is complete.
 */
import type { StringValue, WidgetKey } from "../../widget/strings";
import { de } from "./de";
import { es } from "./es";
import { fr } from "./fr";
import { it } from "./it";

/** A locale's overrides. Partial by design; missing keys render English. */
export type WidgetTable = Partial<Record<WidgetKey, StringValue>>;

export const WIDGET_TABLES: Record<string, WidgetTable> = { de, es, fr, it };
