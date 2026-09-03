---
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

Match a `content` filter key as a literal top-level field name. The key is quoted and escaped into the JSON path rather than interpolated, so `{ 'a.b': 1 }` now selects the field called `a.b` instead of `b` nested inside `a`, a key like `arr[0]` selects that field instead of an array element, and a key that is not path-shaped (`$.`, a stray bracket) is an ordinary zero-match filter instead of a raw SQLite "bad JSON path" error. Brings both SQLite adapters in line with the literal lookup every other adapter performs.
