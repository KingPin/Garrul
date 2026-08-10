-- 0019_audit_log_pii.sql
--
-- Strip personal data out of historical audit_log.meta payloads.
--
-- Three actions used to copy a value into `meta` that is personal data about
-- someone other than the acting admin:
--
--   sub.unsubscribe / sub.resend  ->  meta.email       (a subscriber's address)
--   role.*                        ->  meta.target_name (a user's display name)
--
-- The routes stopped writing them in 2.6.0. This clears the rows already
-- written, which matter because they are the ones that outlive erasure: erasing
-- a user anonymizes `users.name` and deletes their subscriptions, but nothing
-- has ever reached the audit log, so a display name or an address recorded here
-- survived a completed Art. 17 request.
--
-- Neither field carried information that isn't still reachable: the role rows
-- keep `from`/`to` and identify the user by `target_id`, and the subscription
-- rows keep `post_slug` and identify the subscription by `target_id` (the row is
-- soft-unsubscribed, never deleted, so its address is still there).
--
-- json_remove is a SQLite JSON1 function. D1 ships JSON1, verified against the
-- local D1 engine before this migration was written. It returns the document
-- unchanged when the path is absent, so the UPDATE is safe on rows that never
-- had the field, and it is idempotent on re-run.
--
-- Rows whose meta is NULL or not an object are skipped by the json_valid guard
-- rather than being rewritten into the string 'null'.

UPDATE audit_log
   SET meta = json_remove(meta, '$.email')
 WHERE action IN ('sub.unsubscribe', 'sub.resend')
   AND meta IS NOT NULL
   AND json_valid(meta)
   AND json_extract(meta, '$.email') IS NOT NULL;

UPDATE audit_log
   SET meta = json_remove(meta, '$.target_name')
 WHERE action IN ('role.grant_mod', 'role.revoke_mod',
                  'role.grant_admin', 'role.revoke_admin')
   AND meta IS NOT NULL
   AND json_valid(meta)
   AND json_extract(meta, '$.target_name') IS NOT NULL;
