---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-conformance': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

Migrations are declared steps. `migration(from, to, steps)` takes a list built from `rename`, `map`, `add`, `drop` and `derive`, replacing the function form, and checks the list against both handles' schemas when it runs: a step naming a field that is not there, a carried field the target would refuse, or a required field nothing produces throws `StackMigrationError`. `Migration` carries its `steps`.

A collection's content filter or sort now spans the older versions its migrations translate it to, rather than only the handle's version. A key across a `rename` or `add` translates; one across a `derive`, or a sort across a `map`, narrows that version and sets `skipped.older` as before. Two query shapes carry it, each gated by a new capability that is a cap on keys: `filter.contentByType` (a content predicate per `typeId`, never beside `content` or `contentPresent`) and `sort.contentFieldByType` (a sort field or a reduced constant per `typeId`). `StackCapabilities` gains `filter.contentByType` and `sort.contentFieldByType`; local adapters declare 64, and `normalizeCapabilities()` reads an absent or malformed cap as 0. `parseQueryBody()` accepts both shapes. Conformance fixtures pin both shapes and their 400s, and the adapter conformance suite checks them.
