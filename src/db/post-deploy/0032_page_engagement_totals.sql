-- Post-deploy reconcile for 0032_page_engagement_totals.sql. Idempotent.
--
-- `npm run upgrade` migrates, then deploys. Between the two the old Worker
-- still writes page_votes and page_reactions without touching the totals
-- 0032 added, so a slice it changed reads wrong until its next write. This
-- recounts every total from the source rows once the new Worker is live.
-- `npm run upgrade` runs it automatically after a successful deploy; after
-- a manual migrate + deploy, run it yourself:
--   npx wrangler d1 execute DB --remote --file src/db/post-deploy/0032_page_engagement_totals.sql

UPDATE posts SET
	page_votes_up   = (SELECT COUNT(*) FROM page_votes v WHERE v.post_slug = posts.slug AND v.value =  1),
	page_votes_down = (SELECT COUNT(*) FROM page_votes v WHERE v.post_slug = posts.slug AND v.value = -1);

UPDATE page_reaction_totals SET
	count = (SELECT COUNT(*) FROM page_reactions r
	          WHERE r.post_slug = page_reaction_totals.post_slug AND r.kind = page_reaction_totals.kind);

INSERT OR IGNORE INTO page_reaction_totals (post_slug, kind, count)
	SELECT post_slug, kind, COUNT(*) FROM page_reactions GROUP BY post_slug, kind;
