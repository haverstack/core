# `org.haverstack/place@1` — Place

> **Status:** Draft.

A point on Earth the user cares about: a venue, a saved spot, a dropped pin. The durable
half of the check-in pattern — the venue directory — modeled as its own type, while "I
was here" is deliberately _not_ a type (see conventions): any record can be located by
pointing at a place.

Prior art: geo URI (RFC 5870), GeoJSON, vCard `GEO`, schema.org/Place. Coordinates are
named fields rather than a GeoJSON-style array precisely because GeoJSON's
`[longitude, latitude]` ordering is one of software's most reliably fumbled conventions.

## Schema

```ts
await stack.defineType('org.haverstack/place@1', 'Place', {
  latitude: { kind: 'number', required: true },
  longitude: { kind: 'number', required: true },
  name: { kind: 'string' },
  address: { kind: 'string' },
  url: { kind: 'string' },
});
```

## Field semantics

| Field       | Kind     | Required | Meaning                                                                                                                                                                             |
| ----------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latitude`  | `number` | yes      | WGS 84 decimal degrees, −90 to 90. A place is meaningless without coordinates.                                                                                                      |
| `longitude` | `number` | yes      | WGS 84 decimal degrees, −180 to 180.                                                                                                                                                |
| `name`      | `string` | no       | What the user calls it ("Café Grumpy", "Mom's house"). Absent means an unnamed dropped pin. Names are the user's — a perspective they own — not authoritative venue-database names. |
| `address`   | `string` | no       | Freeform, as the user or source formatted it. Structured postal addresses follow the same deferral as `contact`'s.                                                                  |
| `url`       | `string` | no       | The place's website or a canonical map/venue link.                                                                                                                                  |

## Conventions

- **Locating any record — the `location` relationship.** The check-in, the geotagged
  photo, the note written at a café are all the same move:
  `{ kind: 'relationship', label: 'location', recordId: <place record id> }` on the
  located record. This is a cross-type convention (see README): a check-in app is just
  place records plus (possibly caption-less) records pointing at them, and every other
  app's records get geotagging for free. **A check-in's type follows its contract**
  (see [Choosing a text type](./text-types.md)): the private location-diary entry —
  "I was here," addressed to no one — is a (possibly empty-text) `note` with a
  `location` association, its `createdAt` the check-in time; "I'm at the café, come
  join me" sent to a group is a `message` with one; the Foursquare-style public
  check-in is the future broadcast `post` (#15) with one. The `location` association
  is the invariant; the contract varies with the act.
- **Deduplication** is app-side: two records with the same coordinates are two records.
  An app importing venues should query by exact coordinates before creating.
- **No geo queries.** The query engine has no spatial capability and content filters
  are exact-match only, so "places near me" is app-side computation over fetched
  records. Fine at personal scale; recorded here so nobody discovers it by surprise.
- **Altitude, radius/extent, bounding shapes** — excluded from @1; additive candidates
  if a real writer needs them (geo URI's third coordinate is the prior art for
  altitude).

## Read-compat core

```ts
{
  latitude:  { kind: 'number', required: true },
  longitude: { kind: 'number', required: true },
}
```

Anything with required numeric coordinates — a weather station, a photo spot, a transit
stop from some richer app type — can appear on a map consumer's map.

## Deliberately excluded

- Check-in as a type — it's the `location` convention plus any record (see above).
- Venue-database identifiers (OSM node IDs, Foursquare venue IDs, Google place IDs) —
  app sidecar territory; the commons place is the _user's_ place, not a mirror of
  someone's database row.
- Visit history, ratings, favorites — perspectives; tags and sidecars.

## Changelog

- **Draft** — initial definition: `latitude`, `longitude` (required), `name`,
  `address`, `url`.
