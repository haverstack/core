---
'@haverstack/core': minor
---

Keep listing state out of what a record conveys about a file

Both reads behind `getAttachment()`'s access rule ask what a record
conveys, not which records exist, so neither is narrowed by `unlistedAt`.
The reference scan already said so; the uploader clause did not, on either
the content-filtered path or the in-memory fallback an adapter reaching no
content takes. Unlisting your own `_attachment@1` record therefore took
away access to bytes you had uploaded yourself — a withdrawal spelled by a
flag defined not to withhold the record, let alone what it confers.

`combineAdapters()` now forwards `StackRecordAdapter.subscribeChanges()`,
on the same terms as every other optional method. Dropping it left a
combined stack quietly emitting only its own writes while a remote record
backend's feed went unread, and `Stack.relaysChanges` reading false meant a
scoped subscription stopped refusing a feed it cannot narrow.
