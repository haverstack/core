---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
---

A record `id` using the reserved `_` prefix is now refused as `Invalid ID "<id>": uses the reserved "_" prefix.`, the same `Invalid <field> "<value>": <reason>.` shape every other record-ID refusal uses. The `error-bad-request-id-reserved-prefix` fixture pins the new wording.
