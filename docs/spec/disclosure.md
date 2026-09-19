# Refusals and disclosure

What a refused request is allowed to reveal. [Access control](./access-control.md) decides whether a requester may reach a Record; this document decides what they learn when the answer is no.

The two layers there produce two refusals — the Record does not exist, and the requester may not touch it — and which one a requester receives is itself information.

## Which refusal a Record answers with

One rule governs it:

> **A refusal never tells a requester anything a read wouldn't have.** The "forbidden" answer is available exactly to requesters who can already read the Record; to everyone else a Record that exists answers precisely as a missing one does.

So `get()` returns `null` for an unreadable Record just as it does for a missing one — it never throws `StackPermissionError` — and every verb that names a Record by ID (`mutate()`, `patchContent()`, `associate()`, `dissociate()`, `grantAccess()`, `revokeAccess()`, `delete()`, `undelete()`, `getVersions()`, `getVersion()`, `getJournal()`, `restoreVersion()`) throws `StackNotFoundError` where the requester cannot read the Record, and `StackPermissionError` where it can. Over the wire that is 404 and 403 per [§ Error responses](./wire-format.md#error-responses). The same rule places the refusal's message: it reaches only a requester holding the Record already, so it is free to be specific.

**The distinction is withheld from the client, not from the operator.** A server should record which of the two a 404 was, and the check that refused — see [Wire format § Server implementation checklist](./wire-format.md#server-implementation-checklist). Nothing above asks anyone to debug a misconfigured grant blind, and a deployment that keeps no such log is the one most likely to conclude this rule costs more than it is worth.

## Why the distinction is earned

**It is a disclosure.** Record IDs are guessable, and a batch's IDs are derivable from any one of them — neither yields anything without an answer that separates hit from miss. The realistic attacker is not searching the ID space: it is someone legitimately handed one Record who wants to enumerate what was created alongside it, and learn the Stack's write timing and volume. Existence and creation timing are not content, but for a personal Stack, when its owner was writing is itself behavioural information.

Keying on readability rather than on authentication is what makes the rule hold. `did:key` identities are self-minted with no registration authority, so "authenticated" is anonymous with extra steps — [Identity § Authentication](./identity.md#authentication-challengeresponse) already separates 401 from 403 for that reason. Keying on the Record instead reaches every requester who could not read it: a `read-own` holder is not told about another entity's Record of the same type, and a blind-`create` contributor — the drop-box case, and the one most likely to hold a legitimately-shared ID — is told nothing about the submissions filed beside its own. Nothing is lost in the other direction, because a requester who can read the Record learns nothing from being told it exists.

Two edges follow from stating the rule this way rather than in terms of grants:

- **Record-level `permissions` count, like any other route to a read.** A requester holding `read: true` on a Record is told plainly that a write was refused, rather than that a Record it can fetch does not exist.
- **A refusal that never reads the Record discloses nothing either way, and stays as it is.** `commitMigration()`, `deleteAttachment()` and `collectAttachmentGarbage()` refuse every non-owner identically whether or not the named Record or file exists, so they are not oracles despite answering 403.

## What the rule does not close

This is the same closure [reference-creation gating](./access-control.md#reference-creation-gating) applies, pointed the other way. There, a missing target and an inaccessible one both raise `StackPermissionError` for every requester the gate applies to: what failed is the `create()` or `associate()` the requester asked for — that call is genuinely forbidden — and the Record it named is a reference, not the thing addressed. Here the Record _is_ what was addressed, so "not found" is the answer that discloses least. Both collapse the pair; each takes the answer that fits what the caller asked for.

**The closure is in the answer, not in the timing.** Refusing an existing Record does strictly more work than refusing a missing one — a fetch, then a read check that may walk grants and a Group roster — so a caller measuring closely enough can still tell the two apart. Constant-time refusal is not attempted: it would mean paying the read check on every miss, and the deployments this spec targets are not where that trade pays.

A query result carries no count of the whole match, for the same reason — see [Data model § Sorting and pagination](./data-model.md#sorting-and-pagination).
