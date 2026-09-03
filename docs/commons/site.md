# `org.haverstack/site@1` — Site

> **Status:** Draft. Intended writer: a static-site-generator integration reading a
> stack, which builds several sites from one personal stack.

A published website: a personal site, a professional site, a project microsite — one of
possibly several built from the same stack. The gap this closes: the page tree already
supports multiple sites (`parentId` walks terminate on whatever record is the root
ancestor), but nothing says which `article`, `photo`, `bookmark`, or `post` records a
given site publishes, because `collection.typeId` on [`page`](./page.md) is
stack-global — `/articles/` on one site and `/writing/` on another both select every
`article@1` in the stack, with no way to tell them apart.

`collection.tag` cannot carry this either: it is a single string, so spending it on site
membership means a multi-site stack can never have a per-site tag archive. `parentId`
cannot carry it: parenting an article to a site is single-valued, so an article
published on two sites becomes unrepresentable, and it inverts ownership — the article
is the owner's, not any one site's.

## Schema

```ts
await stack.defineType('org.haverstack/site@1', 'Site', {
  title: { kind: 'string', required: true },
  baseUrl: { kind: 'string', required: true },
  description: { kind: 'text' },
  handle: { kind: 'string' },
});
```

## Field semantics

| Field         | Kind     | Required | Meaning                                                                                                                                                                                                                                                                |
| ------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | `string` | yes      | The site's name. Feed titles, `<title>` suffixes, bylines.                                                                                                                                                                                                             |
| `baseUrl`     | `string` | yes      | Origin and optional path prefix the site is published at, no trailing slash. What makes cross-site canonical links and absolute feed URLs derivable. Required because a site is a thing published at a location — without one there is a page tree but not yet a site. |
| `description` | `text`   | no       | Feed and metadata description. Absent means the generator omits it rather than inventing one.                                                                                                                                                                          |
| `handle`      | `string` | no       | Stable lookup key — `personal`, `professional`. Lets a build config name a site without embedding an opaque record ID. Uniqueness is a writer obligation, same posture as `menu.handle`; a generator resolving a handle to zero or several sites fails loudly.         |

## Conventions

- **Containment: root pages are parented to the site.** A [`page`](./page.md) whose
  `parentId` names a `site@1` record is a root page of that site. Path derivation is
  unchanged — walk `parentId` ancestors, stop at the first non-`page` — a `site`
  ancestor is simply one such stop. This is a containment relationship: a page lives at
  exactly one path, so a single-valued native field is correct, same reasoning
  `page.md` already applies to hierarchy.
- **Membership: the `site` cross-type convention.**
  `{ kind: 'relationship', label: 'site', target: { scope: 'record', recordId: <site> } }`
  on an `article`, `photo`, `bookmark`, or `post` means that record is published on that
  site. Multi-valued — two associations means the record appears on both sites, the
  cross-posting case `parentId` can't express. This is a publication relationship: the
  record exists independently of any site and may be published on several, so it stays
  a query rather than a field, same reasoning as `page`'s own hierarchy-vs-membership
  split.
- **Collection scoping is derived, not stored.** A [`page`](./page.md) collection root
  with a `site` ancestor selects only members carrying that site's `site` membership
  association, composed into the same indexed query as any other collection filter:
  ```ts
  {
    typeId: 'org.haverstack/article@1',
    tags: ['travel'],
    relatedTo: { target: { scope: 'record', recordId: siteId }, label: 'site' },
  }
  ```
  Storing the site on the collection instead would denormalize a fact the tree already
  carries, and would let a listing root under one site claim another site's members.
- **Single-site stacks are unaffected.** A page with no `site` ancestor is at the site
  root, and a collection root with no `site` ancestor selects members without regard to
  membership — both rules degrade to current behavior when no `site` record exists.
- **Canonical URLs.** `article.url` (and `photo`/`bookmark`/`post`'s equivalent) is
  stamped with the canonical location at first publish, per each type's own convention.
  A record published on two sites has two locations and one field — resolved by
  whichever site's `baseUrl` prefixes the stored URL being canonical; a site building a
  record whose stored URL points elsewhere renders `<link rel="canonical">` at that
  location instead of claiming it. First publish wins, matching `article.md`'s existing
  write-back convention. Order-independent control, if ever needed, is a
  `site-canonical` label variant marking a copy without an association carrying data —
  not proposed here.

## Read-compat core

```ts
{
  title:   { kind: 'string', required: true },
  baseUrl: { kind: 'string', required: true },
}
```

## Deliberately excluded

- A stored membership list on the site record (`articleIds: string[]`) — associations
  point from the member to the site, not the reverse, so membership stays a live query
  rather than a cache that can go stale.
- Navigation/menu structure, theme, layout — sidecar territory, same posture as `page`.
- `unlisted`/hidden-from-feeds state — governed per-record by the permission model (see
  `docs/spec/access-control.md`), orthogonal to which site a record belongs to.

## Changelog

- **Draft** — initial definition: `title`, `baseUrl` (required), `description`,
  `handle`.
