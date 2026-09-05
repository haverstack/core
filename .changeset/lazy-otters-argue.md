---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
---

Reshape `AdapterCapabilities` around the query surface each entry gates, and collapse the two content-filter flags into one ordered reach:

```ts
type AdapterCapabilities = {
  filter: { content: 'none' | 'field' | 'path'; contentPresent: boolean; search: boolean };
  sort: { fields: NativeSortField[]; contentField: boolean };
  limits: { attachmentBytes: number | null; contentBytes: number | null };
};
```

`filter.content` replaces `contentFieldQuery` and `nestedContentQuery`, which were never siblings: path reach without field reach is not a state an adapter can be in, and two booleans could spell it. As one ordered value the rungs nest by construction, and the query layer compares against a rung instead of consulting one flag before the other.

Every other entry is renamed for the query key it answers for — `filter.search` gates `filter.search`, `sort.fields` gates `sort.field` — so the capability a query needs is derivable from the query rather than memorized, and `APIAdapterCapabilityError.capability` now names it as a path (`'filter.contentPresent'`) rather than a flag. `limits` groups the two byte ceilings apart from the feature flags: nothing is refused for lacking one.

`@haverstack/wire-types` exports `normalizeCapabilities()`, and `APIAdapter.open()` reads every discovery response through it. One rule now covers absent, malformed and unrecognized alike — each resolves to the least capable value it could stand for — where each key previously carried its own default at the call site, and three of them carried none at all: a discovery response omitting `maxAttachmentBytes` left `undefined` behind a `number | null`, which silently skipped the client-side upload pre-check instead of enforcing it. A `filter.content` rung a client does not recognize reads as `'none'` for the same reason silence does: refusing a query is recoverable, presenting an unfiltered superset as a filtered result is not.

The wire shape of `capabilities` changes with the type, and `DiscoveryCapabilities` now types it as a foreign server may actually send it — every field optional, and loose where an unrecognized value is possible.
