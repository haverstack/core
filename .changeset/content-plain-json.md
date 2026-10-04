---
'@haverstack/core': minor
---

Content must be plain JSON at every depth, `open` containers included: a `Date`, `NaN`, `Infinity`, a class instance and the like are refused at their path. A `Date` in a `date` field is refused with a message saying to pass `toISOString()` or a `"YYYY-MM-DD"` string, and validation names a `Date` as `a Date` wherever it reports the type it got.
