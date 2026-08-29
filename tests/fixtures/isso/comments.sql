-- isso comments.db fixture for the dumper (scripts/dump-isso.ts) and the
-- isso adapter (src/lib/import/isso.ts, #108). See PROVENANCE.md in this
-- directory for where the schema and every shape below come from.
--
-- Rows are inserted deliberately out of `id` order within thread 1, so a
-- test asserting output order proves the dumper's own `ORDER BY tid, id`
-- rather than an accident of insertion order.

CREATE TABLE IF NOT EXISTS threads (
	id INTEGER PRIMARY KEY,
	uri VARCHAR(256) UNIQUE,
	title VARCHAR(256)
);

CREATE TABLE IF NOT EXISTS comments (
	tid REFERENCES threads(id),
	id INTEGER PRIMARY KEY,
	parent INTEGER,
	created FLOAT NOT NULL,
	modified FLOAT,
	mode INTEGER,
	remote_addr VARCHAR,
	text VARCHAR NOT NULL,
	author VARCHAR,
	email VARCHAR,
	website VARCHAR,
	likes INTEGER DEFAULT 0,
	dislikes INTEGER DEFAULT 0,
	voters BLOB NOT NULL,
	notification INTEGER DEFAULT 0
);

-- Threads, inserted out of id order for the same reason as the comments below.
INSERT INTO threads (id, uri, title) VALUES
	(3, '/posts/deep/nested/path/', 'Deep'),
	(1, '/hello-world', 'Hello World'),
	(5, '/', 'Home'),
	(2, '/posts/deep/nested/path/?page=2', NULL),
	(4, '/empty', 'Empty');

-- Thread 1 (/hello-world): c1 root, c2 root, c3 reply-to-1 (same
-- name+email as c1: one ghost), c4 root (same name, different email:
-- second ghost), c5 root pending, c6 root tombstone, c7/c8 replies to the
-- tombstone (c8 anonymous), c9 root edited (modified > created).
INSERT INTO comments
	(tid, id, parent, created, modified, mode, remote_addr, text, author, email, website, likes, dislikes, voters, notification)
VALUES
	(1, 5, NULL, 1700000400.111111, NULL, 2, '127.0.0.0',
		'Awaiting moderation from Carol.',
		'Carol Example', 'carol@example.com', NULL, 0, 0, X'00', 0),
	(1, 1, NULL, 1700000000.123456, NULL, 1, '127.0.0.0',
		'This is **bold** text, with a list:

- one
- two

a [link](https://example.com/), a blockquote:

> quoted text

and `inline code`.',
		'Alice Example', 'alice@example.com', 'https://alice.example.com', 3, 1, X'00', 0),
	(1, 9, NULL, 1700000800.555555, 1700000900.666666, 1, '127.0.0.0',
		'Bob edits this comment after posting it.',
		'Bob Example', 'bob@example.org', NULL, 0, 0, X'00', 1),
	(1, 3, 1, 1700000200.345678, NULL, 1, '127.0.0.0',
		'Replying to Alice — still Alice.',
		'Alice Example', 'alice@example.com', 'https://alice.example.com', 0, 0, X'00', 0),
	(1, 2, NULL, 1700000100.234567, NULL, 1, '127.0.0.0',
		'A short reply from Bob.',
		'Bob Example', 'bob@example.org', NULL, 0, 0, X'00', 0),
	(1, 7, 6, 1700000600.333333, NULL, 1, '127.0.0.0',
		'Bob follows up on the removed comment.',
		'Bob Example', 'bob@example.org', NULL, 0, 0, X'00', 0),
	(5, 12, NULL, 1700001100.999999, NULL, 1, '127.0.0.0',
		'A comment on the home page.',
		'Carol Example', 'carol@example.com', NULL, 0, 0, X'00', 0),
	(1, 4, NULL, 1700000300.456789, NULL, 1, '127.0.0.0',
		'Alice again, from a different address this time.',
		'Alice Example', 'alice2@example.net', NULL, 0, 0, X'00', 0),
	(1, 6, NULL, 1700000500.222222, NULL, 4, '127.0.0.0',
		'',
		NULL, 'alice@example.com', NULL, 0, 0, X'00', 0),
	(3, 11, NULL, 1700001000.888888, NULL, 1, '127.0.0.0',
		'Same page without the query string.',
		'Alice Example', 'alice@example.com', NULL, 0, 0, X'00', 0),
	(1, 8, 6, 1700000700.444444, NULL, 1, '127.0.0.0',
		'An anonymous reply.',
		NULL, NULL, NULL, 0, 0, X'00', 0),
	(2, 10, NULL, 1700000900.777777, NULL, 1, '127.0.0.0',
		'First comment on the paginated URL.',
		'Bob Example', 'bob@example.org', NULL, 0, 0, X'00', 0);
-- Thread 4 (/empty) has no comments at all.
