/**
 * Tests for GET /AGENTS.md route — content type, templating, caching, 404 guard.
 *
 * We exercise the real Hono app via app.fetch(new Request(...)) so the
 * mounting + middleware order is part of what's tested.
 */
import { describe, it, expect } from "vitest";
import worker from "../src/index";

type Env = Partial<{
  CANONICAL_URL: string;
  ALLOWED_ORIGINS: string;
}>;

const fetchAgents = (
  path: string,
  init: { host?: string; env?: Env } = {},
) => {
  const url = `https://${init.host ?? "comments.test.example"}${path}`;
  const env: Env = {
    ALLOWED_ORIGINS: "https://blog.example.com",
    ...init.env,
  };
  return worker.fetch(
    new Request(url),
    env as unknown as Record<string, unknown>,
    {} as ExecutionContext,
  );
};

describe("GET /AGENTS.md", () => {
  it("returns markdown with the right content-type", async () => {
    const res = await fetchAgents("/AGENTS.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
  });

  it("returns text/plain when ?format=txt", async () => {
    const res = await fetchAgents("/AGENTS.md?format=txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
  });

  it("?format=txt body is byte-identical to the markdown response", async () => {
    const md = await fetchAgents("/AGENTS.md").then((r) => r.text());
    const txt = await fetchAgents("/AGENTS.md?format=txt").then((r) =>
      r.text(),
    );
    expect(txt).toEqual(md);
  });

  it("substitutes {{INSTANCE_URL}} and {{INSTANCE_HOST}} from Host header", async () => {
    const body = await fetchAgents("/AGENTS.md", {
      host: "comments.alice.dev",
    }).then((r) => r.text());
    expect(body).toContain("https://comments.alice.dev");
    expect(body).toContain("comments.alice.dev");
    expect(body).not.toContain("{{INSTANCE_URL}}");
    expect(body).not.toContain("{{INSTANCE_HOST}}");
  });

  it("CANONICAL_URL wins over Host", async () => {
    const body = await fetchAgents("/AGENTS.md", {
      host: "other.example",
      env: { CANONICAL_URL: "https://canonical.example" },
    }).then((r) => r.text());
    expect(body).toContain("https://canonical.example");
    expect(body).toContain("canonical.example");
    expect(body).not.toContain("other.example");
  });

  it("falls back to Host when CANONICAL_URL is malformed", async () => {
    const res = await fetchAgents("/AGENTS.md", {
      host: "comments.fallback.example",
      env: { CANONICAL_URL: "not-a-url" },
    });
    const body = await res.text();
    expect(body).toContain("comments.fallback.example");
  });

  it("sets Cache-Control: public, max-age=300", async () => {
    const res = await fetchAgents("/AGENTS.md");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("does not require an Origin header (route is public, not /api/*)", async () => {
    // No Origin header on the request; route must return 200, not 403.
    const res = await fetchAgents("/AGENTS.md");
    expect(res.status).toBe(200);
  });
});

describe("GET /AGENTS-OPERATE.md", () => {
  it("returns 404 (operator file is repo-only, never served)", async () => {
    const res = await fetchAgents("/AGENTS-OPERATE.md");
    expect(res.status).toBe(404);
  });
});
