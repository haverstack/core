# `org.haverstack/article@1` — Article

> **Status:** Draft.

A titled written work: a blog post, an essay, a book chapter, a newsletter issue. The
boundary against `note` is the IndieWeb's post-type-discovery rule, adopted here as
doctrine: **a note is an entry without a name; an article is an entry with one** —
plus publication semantics (byline, summary, published date, canonical URL).

One type covers both directions the shape flows: **authored** articles (your own
writing, possibly unpublished) and **captured** articles (a reader-mode save of someone
else's work). The optional fields are where the two diverge; the required core is what
they share.

Prior art: JSON Feed items, Atom entries, microformats `h-entry`, schema.org/Article.
JSON Feed is the closest ancestor — its item shape is nearly this type field-for-field.

## Schema

```ts
await stack.defineType('org.haverstack/article@1', 'Article', {
  title: { kind: 'string', required: true },
  text: { kind: 'text', required: true },
  format: { kind: 'string' },
  summary: { kind: 'text' },
  url: { kind: 'string' },
  author: { kind: 'string' },
  publishedAt: { kind: 'date' },
});
```

## Field semantics

| Field         | Kind     | Required | Meaning                                                                                                                                                                                                                                                                                   |
| ------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | `string` | yes      | The work's name. What makes it an article rather than a note.                                                                                                                                                                                                                             |
| `text`        | `text`   | yes      | The body.                                                                                                                                                                                                                                                                                 |
| `format`      | `string` | no       | Interpretation of `text`. Same vocabulary and defaults as `note`: `"markdown"` (default when absent), `"plain"`; unknown values render as plain.                                                                                                                                          |
| `summary`     | `text`   | no       | Abstract/deck/excerpt. Authored: written or app-derived-and-saved. Captured: the source's own summary. Readers must not regenerate and write back over a present value.                                                                                                                   |
| `url`         | `string` | no       | Canonical location of the published work. Authored drafts have none yet; captured articles always carry the source URL. Presence of `url` is what makes an article record read-compatible with `bookmark` consumers in spirit — though formally `bookmark`'s core requires it, see below. |
| `author`      | `string` | no       | External attribution — the byline as displayed ("Jane Doe"). **Absent means the record's `entityId` (or the stack owner) is the author.** This is deliberately a string, not a reference: a captured work's byline is a property of the work, and its author is rarely a known principal. |
| `publishedAt` | `date`   | no       | When the work was (or will be) published. **Absent means draft/unpublished.** Distinct from `createdAt` (when the record entered the stack) and `updatedAt` (last edit).                                                                                                                  |

## Conventions

- **Draft state** is `publishedAt` absence — a property of the work, not a perspective.
  Editorial workflow states beyond draft/published (in-review, scheduled-vs-published
  nuance) are app sidecar territory.
- **Canonical URL write-back**: on authored articles, the _publishing app_ stamps
  `url` at first publish (a site generator derives the permalink, builds, then writes
  the canonical location back to the record). `url` present therefore means "this work
  lives somewhere on the web" — symmetrically for authored and captured articles — and
  any app can render a "view published" link. Syndicated copies elsewhere never
  overwrite it: canonical means canonical, and a copy's location is a `syndicated-to`
  relationship with an external target — see
  [Cross-type conventions](./README.md#cross-type-conventions).
- **Cover image**: attachment association with label `cover` (JSON Feed `image`,
  h-entry `u-featured`).
- **Embedded media** in `text`: attachment associations with label `embed`, per the
  cross-type convention in the README.
- **Series/collections**: `parentId` when the app has a container record; otherwise tag
  associations.
- **Known authors** use the cross-type `author` relationship (see README) alongside —
  never instead of — the `author` string. Three tiers of acquaintance, three
  mechanisms: a principal writing in this stack is `entityId` (native); someone you
  know is an `author` relationship to their `contact` record; a stranger's byline is
  the `author` string alone. When string and association coexist they don't conflict —
  the association is machine-readable identity ("3 articles by Alice" is a query), the
  string is the byline as displayed, faithful to the work even if the contact is later
  renamed. Co-authorship is multiple `author` associations, with the string holding
  the joint byline ("Alice Smith and Bob Jones").
- **Captured articles** should also carry `{ kind: 'relationship', label: 'about', … }`
  associations from any notes annotating them, and may coexist with a `bookmark` record
  for the same URL (the bookmark is "I saved this link"; the article is "I captured this
  work") — apps that hold both should link them with a `relationship` labeled `capture`
  from the bookmark to the article.
- **Querying published articles**: order by `publishedAt` with
  `sort: { contentField: 'publishedAt' }`. An article with no `publishedAt` — a draft —
  sorts after every published one in either direction, so a listing's first page is
  published articles in date order. What a query still can't express is "where
  `publishedAt` exists": content filters are exact-match, so a consumer wanting only
  published articles pages the sorted result and stops at the first undated record.
  That is why this type carries no redundant required `draft` boolean.

## Read-compat core

```ts
{
  title: { kind: 'string', required: true },
  text:  { kind: 'text', required: true },
}
```

Because `text` is required, every article also satisfies `note`'s core `{ text }` — a
notes app can display your articles as a degenerate case, which is exactly right.
Captured articles carry `url`, but since `url` is optional here, `article@1` as a whole
is _not_ compatible with `bookmark`'s core; capture apps wanting bookmark-consumer reach
keep the paired bookmark record described above.

## Deliberately excluded

- `tags: string[]` — tag associations.
- Layout, theme, rendering hints — presentation is the publishing app's concern.
- `slug` and site-structure fields — that is [`page`](./page.md) territory; an article
  is a work in a feed, a page is a node in a site tree.
- Social/microblog `post` semantics (replies, reposts, mentions) — a separate contract.
  An article is a work; a post is an utterance.
- Comments — already covered, no new type: a comment is a [`message`](./message.md)
  whose `parentId` is the article (sent into a shared space, moment-indexed,
  tamper-evident), while a reader's private marginalia is a `note` with an `about`
  relationship. See [Choosing a text type](./text-types.md) for the ruling.

## Changelog

- **Draft** — initial definition: `title`, `text` (required), `format`, `summary`,
  `url`, `author`, `publishedAt`.
