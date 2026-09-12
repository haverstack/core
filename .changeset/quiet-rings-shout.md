---
'@haverstack/adapter-api': minor
---

Report a success response that carries no usable body as an `APIAdapterError`, on every read as well as the mutations.

`request()` finished with `res.json()`, so a `200` whose body was empty or not JSON threw a raw `SyntaxError` — outside the `APIAdapterError` hierarchy a caller catches to tell a server problem from a bug in its own code, and naming a parse offset rather than the endpoint that misbehaved. `requireRecordBody()` covered only the nine version-bumping mutations, and only once a body had already parsed to `undefined`.

The body is now read once as text, and the two failures it can hold are separated. A body that is **not JSON** is always the server's fault — a proxy error page or a login redirect that got past `res.ok` — and throws an `APIAdapterError` carrying the status, the endpoint and an excerpt of what arrived. An **empty** body is legitimate only where nothing is owed (a `204`, or an endpoint that returns none), and new `requireBody()` / `requireNullableBody()` companions report it everywhere something is: `getRecord`, `getVersion`, `getType`, `queryRecords`, `getVersions`, `listTypes` and the attachment upload now fail the same way the mutations already did, naming the endpoint.

A literal JSON `null` is refused the same way on the reads with no "absent" case. The nullable reads are the behaviour change: an empty `200` from `GET /records/:id`, `GET /records/:id/versions/:version` or `GET /types/:id` now throws instead of parsing to `null`. Absence already has its own unambiguous encoding — a `404` — so reading an empty body as "not there" would let a broken server answer an existence check confidently and wrongly. The wire format says outright that a `200` carries a body, so a server has something normative to conform to.
