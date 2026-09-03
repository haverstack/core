---
'@haverstack/commons': minor
---

Add `SITE`, the `org.haverstack/site@1` commons type: `title` and `baseUrl`
required, `description` and `handle` optional. Lets one personal stack back
several published sites — a root page's `parentId` names the site it belongs
to, and a `{ kind: 'relationship', label: 'site', target: { scope: 'record',
recordId } }` association on an `article`, `photo`, `bookmark`, or `post`
says which site(s) publish it, multi-valued for cross-posting. `page`'s
`collection` roots scope to a site by composing that association into their
query rather than storing site membership on the collection. See
`docs/commons/site.md` and the updated `page.md`/`README.md` conventions.
