---
'@haverstack/core': patch
---

Read a record-level permission's grantee with the same evaluator a `_grant`'s uses, so a stored grantee the write would refuse — an unknown `kind`, or a group arm with no `member`/`admin` role — confers nothing rather than being read as a group's members.
