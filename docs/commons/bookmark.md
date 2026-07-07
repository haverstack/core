# `org.haverstack/bookmark@1` — Bookmark

> **Status:** Draft.

A saved reference to a URL: browser bookmarks, read-later queues, link collections,
citation managers' web entries. The type with the longest prior-art trail (Netscape
bookmark files, del.icio.us, Pinboard, browser sync formats) — and the shape of all of
them is the same: a URL plus optional human annotation.

## Schema

```ts
await stack.defineType('org.haverstack/bookmark@1', 'Bookmark', {
  url: { kind: 'string', required: true },
  title: { kind: 'string' },
  description: { kind: 'text' },
});
```

## Field semantics

| Field         | Kind     | Required | Meaning                                                                                                                                                                           |
| ------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`         | `string` | yes      | The bookmarked URL, as saved. Writers should store it absolute and unmodified beyond safe normalization (scheme/host lowercasing); readers must not assume it is still reachable. |
| `title`       | `string` | no       | Title at save time — usually the page's `<title>`, possibly user-edited. Absent means the app displays the URL.                                                                   |
| `description` | `text`   | no       | User's annotation, or an excerpt captured at save time. Markdown by convention (matching `note`'s default).                                                                       |

## Conventions

- **When it was saved** is `createdAt`. There is no separate `savedAt`.
- **Read-later state** (`unread`, `archived`) is a perspective — tag associations, not
  content. A read-later app and a bookmarks manager sharing these records is exactly the
  interop this type exists for, and they will disagree about read-state; tags let them.
- **Page snapshot**: an archived copy of the page's content is an attachment association
  with label `snapshot` (one per capture; multiple captures are multiple associations).
  The attachment's `mimeType` follows the deterministic first-recorded rule (#65); apps
  should prefer archival-friendly types (PDF, WARC, single-file HTML stored as an
  attachment — served under the #66 safe-list rules).
- **Favicon / preview image**: attachment association with label `preview`.

## Read-compat core

```ts
{ url: { kind: 'string', required: true } }
```

Anything with a required `url` string — a citation, a feed subscription, a web mention —
can be surfaced by a bookmark consumer.

## Deliberately excluded

- `tags: string[]` — tag associations.
- `unread`, `archived`, `favorite` — perspectives.
- `siteName`, `author`, `publishedAt` page metadata — belongs to a future
  `article`/`webpage` proposal (the read-later apps' richer shape), which should be
  read-compatible with this type rather than bloating it.

## Changelog

- **Draft** — initial definition: `url` (required), `title`, `description`.
