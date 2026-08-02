/**
 * Cast a hand-rolled D1 stub to `D1Database`.
 *
 * Tests stub only the surface the code under test actually calls — usually
 * `prepare().bind().first()/all()/run()`. The real `D1Database` also declares
 * `batch`, `exec`, `withSession` and `dump`; implementing them would be dead
 * code that no assertion ever reaches, and a stub that lies about supporting
 * `batch` is worse than one that visibly doesn't.
 *
 * So this is a deliberate cast, named so it's greppable and so the reason
 * lives in one place instead of being re-litigated at every call site. If a
 * code path under test starts calling one of those methods, the stub throws
 * `is not a function` at runtime and the test fails loudly — which is the
 * behaviour we want from a gap in a stub.
 */
import type { D1Database } from "@cloudflare/workers-types";

export const asD1 = (stub: unknown): D1Database => stub as unknown as D1Database;
