---
'@haverstack/core': minor
---

Ask two guards for the value a caller supplied rather than for the key they named, so an explicit `undefined` is no longer read as a claim on the field it names.

`ScopedStack.create()` refuses `createdAt`/`updatedAt` to everyone but the owner acting alone. That refusal now tests both options for a value: `undefined` carries no date, `Stack.create()` already reads it as absent, and a grantee passing one gets the ordinary current-time stamp instead of `StackPermissionError`. A server dropping the two fields from a non-owner `POST /records` body may therefore drop them by value — deleting the keys and setting them to `undefined` are both drops.

`update()` now rejects a top-level patch key whose value is `undefined` with `StackValidationError` (422). A merge patch spells "leave this alone" by omission and "remove this" with `null`, and has no third state left for `undefined` — which cannot arrive over the wire in any case, since JSON has neither a literal for it nor a `JSON.stringify` that emits one. Accepting it resolved the ambiguity two ways at once: storage dropped the key, while the presence checks a patch passes through read it as a value. The visible effect was on `_app` cards, where a write-holder patching `{ did: undefined }` was refused for repointing a DID it never sent — a permission error naming a field the caller did not set, for a patch the owner got a validation error for. `ScopedStack.update()` applies the check ahead of its own binding fences, so the malformed patch is now the same error for every requester.
