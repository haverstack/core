---
'@haverstack/core': minor
---

Exempt the owner acting alone from the reference-creation gate, so the answers a caller-named `parentId` owes are reachable through a `ScopedStack`.

`canReadReferent()` resolved the destination and refused a missing one before `Stack` ran either of the checks a caller-named `parentId` is owed. Because a record that does not exist is unreadable by everyone, the owner's documented exemption from the gate — keyed on readability — silently stopped applying to absence, and both `validateParentId()`'s `StackQueryError` (wire: 400) and `assertParentExists()`'s `StackConflictError` (wire: 409) collapsed into `StackPermissionError` for every requester going through a scope.

The owner acting alone now passes the gate before the lookup, handing the question to `Stack`. This grants nothing — there is no record in their own stack the owner may not read — and the anti-oracle property is unchanged for every other requester, for whom missing and unreadable remain one indistinguishable refusal. Delegation does not carry the exemption on either side.

One consequence follows: the owner may name a `relationship` target that does not exist, exactly as an unscoped `Stack` allows. `restoreVersion()` is unaffected — it already skipped the whole snapshot-gating block for the owner acting alone, so the spec's promise that a snapshot naming a since-hard-deleted container restores anyway was already honored there.
