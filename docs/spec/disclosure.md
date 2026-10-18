# Refusals and disclosure

What a refused request is allowed to reveal. [Access control](./access-control.md) decides whether a requester may reach a Record; this document decides what they learn when the answer is no.

The two layers there produce two refusals — the Record does not exist, and the requester may not touch it — and which one a requester receives is itself information.

## Which refusal a Record answers with

One rule governs it:

> **A refusal never tells a requester anything a read wouldn't have.** The "forbidden" answer is available exactly to requesters who can already read the Record; to everyone else a Record that exists answers precisely as a missing one does.

So `get()` returns `null` for an unreadable Record just as it does for a missing one — it never throws `StackPermissionError` — and every verb that names a Record by ID (`patchContent()`, `setParent()`, `setUnlisted()`, `editAssociations()`, `setAssociations()`, `editAccess()`, `setAccess()`, `delete()`, `undelete()`, `getVersions()`, `getVersion()`, `getJournal()`, `restoreVersion()`) throws `StackNotFoundError` where the requester cannot read the Record, and `StackPermissionError` where it can. Over the wire that is 404 and 403 per [§ Error responses](./wire-format.md#error-responses). The same rule places the refusal's message: it reaches only a requester holding the Record already, so it is free to be specific: a `StackPermissionError` names the verb, the Record and its type, and what was missing, and says which side lacked it when the requester is delegated.

**The distinction is withheld from the client, not from the operator.** A server should record which of the two a 404 was, and the check that refused — see [Wire format § Server implementation checklist](./wire-format.md#server-implementation-checklist). Nothing above asks anyone to debug a misconfigured grant blind, and a deployment that keeps no such log is the one most likely to conclude this rule costs more than it is worth.

## Why the distinction is earned

**It is a disclosure.** Record IDs are guessable, and a batch's IDs are derivable from any one of them — neither yields anything without an answer that separates hit from miss. The realistic attacker is not searching the ID space: it is someone legitimately handed one Record who wants to enumerate what was created alongside it, and learn the Stack's write timing and volume. Existence and creation timing are not content, but for a personal Stack, when its owner was writing is itself behavioural information.

Keying on readability rather than on authentication is what makes the rule hold. `did:key` identities are self-minted with no registration authority, so "authenticated" is anonymous with extra steps — [Identity § Authentication](./identity.md#authentication-challengeresponse) already separates 401 from 403 for that reason. Keying on the Record instead reaches every requester who could not read it: a `read-own` holder is not told about another entity's Record of the same type, and a blind-`create` contributor — the drop-box case, and the one most likely to hold a legitimately-shared ID — is told nothing about the submissions filed beside its own. Nothing is lost in the other direction, because a requester who can read the Record learns nothing from being told it exists.

Two edges follow from stating the rule this way rather than in terms of grants:

- **Record-level `permissions` count, like any other route to a read.** A requester holding a `read` element on a Record is told plainly that a write was refused, rather than that a Record it can fetch does not exist.
- **A refusal that never reads the Record discloses nothing either way, and stays as it is.** `commitMigration()`, `deleteAttachment()` and `collectAttachmentGarbage()` refuse every non-owner identically whether or not the named Record or file exists, so they are not oracles despite answering 403.

## The order a write's refusals are asked in

A write to an existing Record can fail more than one check at once, and which answer it gets has to be the same for every requester and every verb, or the difference becomes the disclosure this document exists to prevent. Every write asks in this order, and answers with the first refusal it reaches:

1. **The request's own shape** — a list that is not a list, a parent that is neither an id nor `null`, a content patch that is not an object or carries an `undefined`, a malformed or misrouted element: `400` or `422`. Asked before anything is read, so it answers the same whether or not the Record exists.
2. **Whether the requester may reach the Record** — `404` when it is missing, outside the family a typed call names, or unreadable to this requester ([above](#which-refusal-a-record-answers-with)).
3. **Whether the requester may make this write** — `403`, including the [reference gates](./access-control.md#reference-creation-gating) on what the write would add.
4. **The Record's state** — `409` if it is soft-deleted, then `412` if `ifVersion` is stale. A stale caller learns that before anything about its input, since its input was written against a Record that has moved on.
5. **What the write changes, checked against the Record as it stands** — merged content against the Record's type (`422`); a new parent's form (`400`), existence and ancestry (`409`).
6. **A write that moves nothing returns the Record unchanged**, writing and announcing nothing. It never reaches step 7, so it is never refused for a stored state it did not produce.
7. **Rules over the set the write would produce** — a `_group` keeps an `admin` (`409`), and no grantee holds `write` without `read` (`422`), asked of the set the write lands on rather than an earlier read ([Versioning § Element-set writes compare the set they read](./versioning.md#element-set-writes-compare-the-set-they-read)).

Steps 2 and 3 are `ScopedStack`'s; an unscoped `Stack` asks the rest in the same order.

## Scoped cursors are sealed

> **A cursor a scoped query hands back names nothing its requester could not read, and only a cursor the stack sealed resumes.**

An adapter's cursor says where the next page starts: the ID of the last Record a page scanned and, under a sort, that Record's sort value — for a content sort, the field's stored text. A [permission-scoped](./access-control.md) query scans Records it then withholds, so the adapter's cursor routinely names one of them. Handed back as it stands, it would tell an anonymous requester the IDs and creation times this document withholds, and a content-sorted query would read out the sorted field of every Record it could not see, one page at a time. A cursor the requester could write would be worse: choosing where a scan starts, over a content sort, is a search over values it cannot read.

So `ScopedStack.query()` returns a **sealed** cursor — the adapter's, encrypted and authenticated (AES-GCM) under a key only the stack holds — and opens only cursors it sealed; anything else, including an adapter cursor passed through verbatim, is a malformed cursor and **400**, as an undecodable one is everywhere. The key is `_config.cursorKey`, minted the first time a scoped query needs one and kept in the stack ([The `_config` record](../spec.md#the-_config-record)), so a cursor resumes after a restart and on any instance serving the same store. An unscoped `Stack` returns the adapter's cursor unchanged: its caller can read every Record a cursor could name.

## What the rule does not close

This is the same closure [reference-creation gating](./access-control.md#reference-creation-gating) applies, pointed the other way. There, a missing target and an inaccessible one both raise `StackPermissionError` for every requester the gate applies to: what failed is the `create()` or `editAssociations()` the requester asked for — that call is genuinely forbidden — and the Record it named is a reference, not the thing addressed. Here the Record _is_ what was addressed, so "not found" is the answer that discloses least. Both collapse the pair; each takes the answer that fits what the caller asked for.

**The closure is in the answer, not in the timing.** Refusing an existing Record does strictly more work than refusing a missing one — a fetch, then a read check that may walk grants and a Group roster — so a caller measuring closely enough can still tell the two apart. Constant-time refusal is not attempted: it would mean paying the read check on every miss, and the deployments this spec targets are not where that trade pays.

**Neither is the page size.** A scoped query reads a bounded window per call, so how many Records one page returns still varies with how many unreadable Records sit between the readable ones. Sealing the cursor hides which Records those are and what they hold, not that the window was spent on something.

A query result carries no count of the whole match, for the same reason — see [Data model § Sorting and pagination](./data-model.md#sorting-and-pagination).
