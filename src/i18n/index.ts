import { en, type StringKey } from "./en";

const locales = { en } as const;
type Locale = keyof typeof locales;

let active: Locale = "en";

export const setLocale = (loc: Locale): void => {
	active = loc;
};

export const t = (key: StringKey, vars?: Record<string, string | number>): string => {
	const table = locales[active];
	const raw = table[key] ?? key;
	if (!vars) return raw;
	return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
		name in vars ? String(vars[name]) : `{${name}}`,
	);
};
