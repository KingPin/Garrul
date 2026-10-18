// Vitest setup file: the settings memo is module-level, so without this a
// test would read the previous test's resolved settings. Runs before every test.
import { beforeEach } from "vitest";
import { bustSettingsCache } from "../../src/lib/settings";
import type { Bindings } from "../../src/index";

// Note: this imports the settings module graph before any test's `vi.mock`, so a
// future `vi.mock` of a module in that graph would split module instances.
beforeEach(async () => {
	await bustSettingsCache({
		TREE_CACHE: { delete: async () => {} },
	} as unknown as Bindings);
});
