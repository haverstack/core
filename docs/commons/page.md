# `org.haverstack/page@1` — Page

> **Status:** Draft. Intended writer: a static-site-generator integration reading a
> stack (in progress by the project maintainer — either a standalone generator or an
> Eleventy data source).

A node in a website's structure: the about page, the colophon, the landing page. The
boundary against [`article`](./article.md): **an article is a work in a feed
(chronological, canonical URL, stands alone); a page is a location in a site tree**
(structural identity via slug and hierarchy). A typical personal site is a handful of
`page` records plus a stream of `article` records.

The interop this type exists for is escaping static-site-generator lock-in: today a
site's content is trapped in one generator's front-matter dialect and directory layout;
as stack records, the same site content can be built by any generator with a stack
integration.

Prior art: every SSG's front matter (Jekyll/Hugo/Eleventy), WordPress's page-vs-post
distinction, CMS content models. The design keeps what they agree on (slug, title,
body, published state) and pushes what they fight about (layout, templates, navigation
order) to app sidecars.

## Schema

```ts
await stack.defineType('org.haverstack/page@1', 'Page', {
  slug: { kind: 'string', required: true },
  text: { kind: 'text', required: true },
  title: { kind: 'string' },
  format: { kind: 'string' },
  publishedAt: { kind: 'date' },
});
```

## Field semantics

| Field         | Kind     | Required | Meaning                                                                                                                                                                                                              |
| ------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`        | `string` | yes      | This page's **path segment** — not the full path. URL-safe, lowercase, no slashes. The full path is derived by walking `parentId` ancestors (see conventions). The page's structural identity: what makes it a page. |
| `text`        | `text`   | yes      | The body.                                                                                                                                                                                                            |
| `title`       | `string` | no       | Display/`<title>` text. Absent means the app derives one (from `slug`, or none for a homepage).                                                                                                                      |
| `format`      | `string` | no       | Same vocabulary and defaults as `note`/`article`: `"markdown"` (default), `"plain"`.                                                                                                                                 |
| `publishedAt` | `date`   | no       | Absent means draft — same convention as `article`. Generators skip drafts by default.                                                                                                                                |

## Conventions

- **Hierarchy is `parentId`.** A page whose parent is another page is nested under it:
  `slug: "history"` under a page with `slug: "about"` builds at `/about/history/`. A
  page with no page ancestor is at the site root. Homepages use slug `index` by
  convention, mapping to the tree position's own path.
- **The site container is app territory** — same posture as task lists and photo
  albums. An app managing multiple sites parents each site's root pages to its own
  site record; single-site setups need no container at all. What interops is the pages.
- **Uniqueness of paths** (no two siblings sharing a slug) is a writer obligation, not
  schema-enforceable; generators should fail loudly on collision rather than pick one.
- **Layout, template, navigation order, front-matter extras** — the fields generators
  disagree on — live in the generating app's sidecar type, linked by a `relationship`
  association. A page with no sidecar must still build sensibly (default template).
- **Embedded media**: attachment associations with label `embed`, per the cross-type
  convention.
- **Blog posts are `article`, not `page`.** A generator maps articles → the
  chronological collection (permalinks derived from `publishedAt`/`title` are the
  generator's business) and pages → the site tree. If a post genuinely needs a
  hand-placed path, that's the generator's permalink override — sidecar, not commons.
- **Collection membership is a query, not a field.** For the common single-site case,
  the generator's collection is simply every `article` with `publishedAt` set —
  publishing _is_ setting `publishedAt`; nothing else is recorded. When selection must
  be narrower (multiple sites from one stack, guest posts published elsewhere), the
  generator narrows its query — by `parentId` to its site record, or by a tag its
  config names. A stored "on this site" flag would be a stale-able cache of that
  query, so none exists. The generator stamps the article's canonical `url` at first
  publish (see `article.md`).

## Read-compat core

```ts
{
  slug: { kind: 'string', required: true },
  text: { kind: 'text', required: true },
}
```

Also satisfies `note`'s `{ text }` core, so notes apps can read pages too — editing
your site's about page in your notes app is a legitimate and intended consequence.

## Deliberately excluded

- `layout`/`template` — the most app-specific field in every front-matter dialect.
- Navigation order/menus — a perspective of the site structure; sidecar.
- Full-path slugs — deriving the path from the tree keeps moves (re-parenting) atomic
  and collision rules local; a denormalized full path would go stale.
- Redirects/aliases — future additive candidate once a real generator needs it
  (`aliases: array<string>` is the likely shape, prior art in Hugo/Jekyll).

## Changelog

- **Draft** — initial definition: `slug`, `text` (required), `title`, `format`,
  `publishedAt`.
