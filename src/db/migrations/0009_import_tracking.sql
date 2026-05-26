-- 0009_import_tracking.sql
--
-- Track imported comments so re-running the same import is idempotent.
--
-- Without these columns, a Disqus (or future WordPress / generic CSV)
-- importer that crashes halfway through has no way to safely resume —
-- re-running would duplicate every row up to the crash point.
--
-- Design:
--   * `import_source` is a free-form tag, e.g. 'disqus', 'wordpress'.
--   * `import_id` is the source platform's stable ID for the post
--     (Disqus uses `dsq:link` and a per-comment `dsq:id`).
--   * A partial UNIQUE index on the pair lets multiple sources coexist:
--     two different `disqus` imports of the same XML are a re-run (no-op),
--     while a parallel WordPress import with overlapping IDs is allowed.
--   * Native rows (typed in via the widget) skip the columns entirely —
--     `WHERE import_source IS NOT NULL` keeps the index narrow and the
--     constraint inert for normal traffic.

ALTER TABLE comments ADD COLUMN import_source TEXT;
ALTER TABLE comments ADD COLUMN import_id     TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS comments_import_idx
  ON comments(import_source, import_id)
  WHERE import_source IS NOT NULL;

-- Ghost users created by an importer are flagged so the operator can
-- distinguish a real anonymous commenter from a Disqus carryover. We
-- reuse `provider='anon'` so existing rate-limit + read paths Just Work;
-- the marker lives in a side column to keep that join semantics intact.
ALTER TABLE users ADD COLUMN import_source TEXT;
