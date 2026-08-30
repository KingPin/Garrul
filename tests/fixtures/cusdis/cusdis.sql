-- Cusdis db.sqlite fixture for the dumper (scripts/dump-cusdis.ts) and the
-- Cusdis adapter (src/lib/import/cusdis.ts, #109). See PROVENANCE.md in this
-- directory for where the schema and every shape below come from.
--
-- Rows are inserted deliberately out of `created_at` order within the
-- /hello-world page, so a test asserting output order proves the dumper's own
-- `ORDER BY created_at, id` rather than an accident of insertion order.
--
-- Only the three tables the dumper reads are created. A real Cusdis database
-- also holds next-auth's users / accounts / sessions / verification_requests;
-- they describe the operator and carry live credentials, and the dumper
-- never opens them, so a fixture that omitted them proves the dumper does
-- not depend on them.

CREATE TABLE "projects" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"title" TEXT NOT NULL,
	"created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"deleted_at" DATETIME,
	"ownerId" TEXT NOT NULL,
	"token" TEXT,
	"fetch_latest_comments_at" DATETIME,
	"enable_notification" BOOLEAN DEFAULT true,
	"webhook" TEXT,
	"enableWebhook" BOOLEAN
);

CREATE TABLE "pages" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"slug" TEXT NOT NULL,
	"url" TEXT,
	"title" TEXT,
	"created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"projectId" TEXT NOT NULL,
	CONSTRAINT "pages_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "projectId" ON "pages"("projectId");

CREATE TABLE "comments" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"pageId" TEXT NOT NULL,
	"created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"deletedAt" DATETIME,
	"moderatorId" TEXT,
	"by_email" TEXT,
	"by_nickname" TEXT NOT NULL,
	"content" TEXT NOT NULL,
	"approved" BOOLEAN NOT NULL DEFAULT false,
	"parentId" TEXT,
	CONSTRAINT "comments_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
	CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Two projects in one database. One Cusdis instance hosts many sites, and a
-- whole-DB dump spans all of them; both carry an `/about` page so a flattening
-- import would collide them. `token` is the project's widget API token — a
-- credential — and is set here precisely so a test can prove the dumper never
-- emits it. Inserted out of id order.
INSERT INTO "projects" ("id", "title", "created_at", "updated_at", "deleted_at", "ownerId", "token", "fetch_latest_comments_at", "enable_notification", "webhook", "enableWebhook") VALUES
	('22222222-2222-4222-8222-222222222222', 'Example Docs', 1700000000000, 1700000000000, NULL, 'u0000001-0000-4000-8000-000000000001', 'fixture-token-do-not-emit-2', NULL, 1, NULL, NULL),
	('11111111-1111-4111-8111-111111111111', 'Example Blog', 1699990000000, 1699990000000, NULL, 'u0000001-0000-4000-8000-000000000001', 'fixture-token-do-not-emit-1', 1700002000000, 1, NULL, NULL);

-- Pages. `slug` is what the widget sent as `data-page-id` — client-declared,
-- so it can be anything (see /what is this?). `url` and `title` are both
-- nullable and both null on /about (the widget only sets them when the host
-- page passes data-page-url / data-page-title). /empty has no comments at
-- all: the dumper keeps it, the adapter drops it.
INSERT INTO "pages" ("id", "slug", "url", "title", "created_at", "updated_at", "projectId") VALUES
	('p0000001-0000-4000-8000-000000000001', '/hello-world', 'https://blog.example.com/hello-world', 'Hello World', 1700000000000, 1700000000000, '11111111-1111-4111-8111-111111111111'),
	('p0000002-0000-4000-8000-000000000002', '/about', NULL, NULL, 1700001000000, 1700001000000, '11111111-1111-4111-8111-111111111111'),
	('p0000003-0000-4000-8000-000000000003', '/deep-thread', 'https://blog.example.com/deep-thread', 'Deep', 1700002000000, 1700002000000, '11111111-1111-4111-8111-111111111111'),
	('p0000004-0000-4000-8000-000000000004', '/what is this?', NULL, 'Odd slug', 1700003000000, 1700003000000, '11111111-1111-4111-8111-111111111111'),
	('p0000005-0000-4000-8000-000000000005', '/empty', 'https://blog.example.com/empty', 'Empty', 1700004000000, 1700004000000, '11111111-1111-4111-8111-111111111111'),
	('p0000006-0000-4000-8000-000000000006', '/about', 'https://docs.example.com/about', 'About the docs', 1700005000000, 1700005000000, '22222222-2222-4222-8222-222222222222');

-- /hello-world (project 1): c1 root, c2 root (markdown body), c3 reply-to-c1
-- (same name+email as c1: one ghost), c4 root (same name, NULL email: a
-- second ghost — by_email is nullable and often null), c5 root unapproved
-- (Cusdis' moderation queue), c6 root soft-deleted (deletedAt set; Cusdis
-- keeps nickname, email and content on a deleted row and does NOT cascade
-- to replies), c7/c8 replies to the deleted c6 (c8 with a blank nickname
-- and no email), c9 root with updated_at > created_at (a moderation bump —
-- Cusdis has no edit feature, so the adapter must NOT read it as an edit),
-- c10 root soft-deleted with no replies at all, c11 an unapproved reply to
-- c1.
INSERT INTO "comments" ("id", "pageId", "created_at", "updated_at", "deletedAt", "moderatorId", "by_email", "by_nickname", "content", "approved", "parentId") VALUES
	('c0000005-0000-4000-8000-000000000005', 'p0000001-0000-4000-8000-000000000001', 1700000400000, 1700000400000, NULL, NULL, 'carol@example.com', 'Carol Example', 'Awaiting moderation from Carol.', 0, NULL),
	('c0000001-0000-4000-8000-000000000001', 'p0000001-0000-4000-8000-000000000001', 1700000000000, 1700000000000, NULL, 'u0000001-0000-4000-8000-000000000001', 'alice@example.com', 'Alice Example', 'This is **bold** text, with a list:

- one
- two

a [link](https://example.com/), a blockquote:

> quoted text

and `inline code`.', 1, NULL),
	('c0000009-0000-4000-8000-000000000009', 'p0000001-0000-4000-8000-000000000001', 1700000800000, 1700000900000, NULL, NULL, 'bob@example.org', 'Bob Example', 'Bob edits this comment after posting it.', 1, NULL),
	('c0000003-0000-4000-8000-000000000003', 'p0000001-0000-4000-8000-000000000001', 1700000200000, 1700000200000, NULL, NULL, 'alice@example.com', 'Alice Example', 'Replying to Alice — still Alice.', 1, 'c0000001-0000-4000-8000-000000000001'),
	('c0000002-0000-4000-8000-000000000002', 'p0000001-0000-4000-8000-000000000001', 1700000100000, 1700000100000, NULL, NULL, 'bob@example.org', 'Bob Example', 'A short reply from Bob.', 1, NULL),
	('c0000007-0000-4000-8000-000000000007', 'p0000001-0000-4000-8000-000000000001', 1700000600000, 1700000600000, NULL, NULL, 'bob@example.org', 'Bob Example', 'Bob follows up on the removed comment.', 1, 'c0000006-0000-4000-8000-000000000006'),
	('c0000004-0000-4000-8000-000000000004', 'p0000001-0000-4000-8000-000000000001', 1700000300000, 1700000300000, NULL, NULL, NULL, 'Alice Example', 'Alice again, without leaving an address this time.', 1, NULL),
	('c0000006-0000-4000-8000-000000000006', 'p0000001-0000-4000-8000-000000000001', 1700000500000, 1700000500000, 1700001500000, 'u0000001-0000-4000-8000-000000000001', 'dave@example.net', 'Dave Example', 'This comment was removed by the moderator but its replies stayed.', 1, NULL),
	('c0000011-0000-4000-8000-000000000011', 'p0000001-0000-4000-8000-000000000001', 1700001000000, 1700001000000, NULL, NULL, 'carol@example.com', 'Carol Example', 'An unapproved reply to Alice.', 0, 'c0000001-0000-4000-8000-000000000001'),
	('c0000008-0000-4000-8000-000000000008', 'p0000001-0000-4000-8000-000000000001', 1700000700000, 1700000700000, NULL, NULL, NULL, '', 'A reply with no name at all.', 1, 'c0000006-0000-4000-8000-000000000006'),
	('c0000010-0000-4000-8000-000000000010', 'p0000001-0000-4000-8000-000000000001', 1700000900000, 1700000900000, 1700001600000, 'u0000001-0000-4000-8000-000000000001', 'dave@example.net', 'Dave Example', 'Removed, and nobody had replied to it.', 1, NULL);

-- /about (project 1): one comment, on a page with no url and no title.
INSERT INTO "comments" ("id", "pageId", "created_at", "updated_at", "deletedAt", "moderatorId", "by_email", "by_nickname", "content", "approved", "parentId") VALUES
	('c0000012-0000-4000-8000-000000000012', 'p0000002-0000-4000-8000-000000000002', 1700001100000, 1700001100000, NULL, NULL, 'carol@example.com', 'Carol Example', 'A comment on a page Cusdis knows only by slug.', 1, NULL);

-- /deep-thread (project 1): a ten-deep reply chain. Cusdis' `parentId` is an
-- unbounded self-relation, so a database can nest deeper than MAX_REPLY_DEPTH
-- (8); d9 and d10 must be re-parented onto the deepest permitted ancestor,
-- not dropped.
INSERT INTO "comments" ("id", "pageId", "created_at", "updated_at", "deletedAt", "moderatorId", "by_email", "by_nickname", "content", "approved", "parentId") VALUES
	('d0000001-0000-4000-8000-000000000001', 'p0000003-0000-4000-8000-000000000003', 1700002001000, 1700002001000, NULL, NULL, 'alice@example.com', 'Alice Example', 'Depth 1.', 1, NULL),
	('d0000002-0000-4000-8000-000000000002', 'p0000003-0000-4000-8000-000000000003', 1700002002000, 1700002002000, NULL, NULL, 'bob@example.org', 'Bob Example', 'Depth 2.', 1, 'd0000001-0000-4000-8000-000000000001'),
	('d0000003-0000-4000-8000-000000000003', 'p0000003-0000-4000-8000-000000000003', 1700002003000, 1700002003000, NULL, NULL, 'alice@example.com', 'Alice Example', 'Depth 3.', 1, 'd0000002-0000-4000-8000-000000000002'),
	('d0000004-0000-4000-8000-000000000004', 'p0000003-0000-4000-8000-000000000003', 1700002004000, 1700002004000, NULL, NULL, 'bob@example.org', 'Bob Example', 'Depth 4.', 1, 'd0000003-0000-4000-8000-000000000003'),
	('d0000005-0000-4000-8000-000000000005', 'p0000003-0000-4000-8000-000000000003', 1700002005000, 1700002005000, NULL, NULL, 'alice@example.com', 'Alice Example', 'Depth 5.', 1, 'd0000004-0000-4000-8000-000000000004'),
	('d0000006-0000-4000-8000-000000000006', 'p0000003-0000-4000-8000-000000000003', 1700002006000, 1700002006000, NULL, NULL, 'bob@example.org', 'Bob Example', 'Depth 6.', 1, 'd0000005-0000-4000-8000-000000000005'),
	('d0000007-0000-4000-8000-000000000007', 'p0000003-0000-4000-8000-000000000003', 1700002007000, 1700002007000, NULL, NULL, 'alice@example.com', 'Alice Example', 'Depth 7.', 1, 'd0000006-0000-4000-8000-000000000006'),
	('d0000008-0000-4000-8000-000000000008', 'p0000003-0000-4000-8000-000000000003', 1700002008000, 1700002008000, NULL, NULL, 'bob@example.org', 'Bob Example', 'Depth 8.', 1, 'd0000007-0000-4000-8000-000000000007'),
	('d0000009-0000-4000-8000-000000000009', 'p0000003-0000-4000-8000-000000000003', 1700002009000, 1700002009000, NULL, NULL, 'alice@example.com', 'Alice Example', 'Depth 9 — past the cap.', 1, 'd0000008-0000-4000-8000-000000000008'),
	('d0000010-0000-4000-8000-000000000010', 'p0000003-0000-4000-8000-000000000003', 1700002010000, 1700002010000, NULL, NULL, 'bob@example.org', 'Bob Example', 'Depth 10 — also past the cap.', 1, 'd0000009-0000-4000-8000-000000000009');

-- /what is this? (project 1): a slug the read API would reject — space and
-- `?` both fail SLUG_RE — so the adapter has to digest it.
INSERT INTO "comments" ("id", "pageId", "created_at", "updated_at", "deletedAt", "moderatorId", "by_email", "by_nickname", "content", "approved", "parentId") VALUES
	('c0000013-0000-4000-8000-000000000013', 'p0000004-0000-4000-8000-000000000004', 1700003100000, 1700003100000, NULL, NULL, 'alice@example.com', 'Alice Example', 'A comment on a page whose slug is not a slug.', 1, NULL);

-- /about (project 2): the colliding page on the other site.
INSERT INTO "comments" ("id", "pageId", "created_at", "updated_at", "deletedAt", "moderatorId", "by_email", "by_nickname", "content", "approved", "parentId") VALUES
	('c0000014-0000-4000-8000-000000000014', 'p0000006-0000-4000-8000-000000000006', 1700005100000, 1700005100000, NULL, NULL, 'erin@example.com', 'Erin Example', 'A comment on the other project''s about page.', 1, NULL);
