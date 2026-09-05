# Unlisted records

Whether a Record is enumerable, as opposed to who may read it. For who may read or write it, see [Access control](./access-control.md); for the feed's matching behavior, see [Change events § The unlisted transition](./events.md#the-unlisted-transition).

`unlistedAt` is a native field, orthogonal to `permissions`: it says nothing about who may read a Record, only whether it is enumerable. A Record with `unlistedAt` set is reachable by `get()` for anyone who may already read it, and absent from an unfiltered `query()` and the change feed by default — a signal for content that is genuinely public where the _location_ is what's being withheld (a bonus post for feed subscribers, a superseded page kept alive for old links), never a substitute for `permissions` on content that must stay unreadable.

```ts
type StackRecord = {
  // ...
  unlistedAt?: Date; // Present if withheld from enumeration
};

type RecordFilter = {
  // ...
  includeUnlisted?: boolean; // Unlisted Records are excluded by default
};
```

**Stated plainly, because the name will otherwise over-promise:**

> Unlisted withholds a Record from enumeration and announcement. It never withholds the Record. A requester who may read it and holds its ID gets it. A requester without the ID has no supported way to discover it.

That sits inside the same threat model as [record IDs being guessable](./access-control.md#errors-and-information-exposure) — "refuse to confirm a candidate" is the existing posture, and unlisted is that posture applied to discovery rather than to a single ID.

## Three tiers, not two

The reach question access control usually asks is binary — enforced or not — but enumeration has a real middle tier, and `unlistedAt` occupies it rather than inventing a softer word for "advisory":

|               | Behavior                                   | Occupants                            |
| ------------- | ------------------------------------------ | ------------------------------------ |
| **Enforced**  | Refused regardless of what the caller asks | `permissions`, grants                |
| **Defaulted** | Refused unless the caller asks             | `deletedAt`, `unlistedAt`, `_config` |
| **Advisory**  | Always returned; the consumer decides      | A tag convention                     |

A consumer that has never heard of `unlistedAt` gets correct behavior by default — an unfiltered `query()` excludes it, the same posture as `deletedAt` and `_config`. That default is what makes the field real rather than a documentation-only convention: nothing about it depends on every consumer choosing to respect it.

## Setting it

```ts
await stack.create(typeId, content, { unlisted: true }); // created already unlisted — no window where it's briefly enumerable
await stack.setUnlisted(recordId, true); // withhold an existing Record — answers with the Record
await stack.setUnlisted(recordId, false); // relist it
```

`setUnlisted()` is gated exactly like [`setPermissions()`](./access-control.md#the-write-bit-a-recoverability-trust-model) under `ScopedStack` — owner-or-creator, asked of both identities under delegation — because both decide who or what can _discover_ a Record rather than merely read one already found. `_group` Records follow the same admin-or-owner rule `setPermissions()` uses there too. No-op if the Record is already in the requested state, which answers with the Record unchanged — see [Versioning § Version history](./versioning.md#version-history).

## `includeUnlisted` is owner-only

Unlike `includeDeleted` — which any `ScopedStack` requester may pass, since a soft-deleted Record's own `permissions` still gate whether they can see it, and what comes back is [a tombstone rather than the Record](./versioning.md#the-tombstone-is-literal) — **`includeUnlisted` is refused to everyone but the owner acting alone**, on both `query()` and `subscribe()`:

```ts
stack.query({ filter: { includeUnlisted: true } }); // plain Stack: honored
scoped.query({ filter: { includeUnlisted: true } }); // ScopedStack, non-owner: StackPermissionError
```

Enumeration standing rests on nothing but ownership. A grant conveys reach over specific Records or a type family; it says nothing about whether the requester should see the stack's _entire_ enumeration surface, unlisted Records included — so no grant, and no delegation, carries the flag. An owner principal acting for a visitor through the owner's own server does not lend that visitor the flag either, for the same reason delegation carries none of the [owner-acting-alone verbs](./access-control.md#delegation-principal-and-subject). The flag is refused outright rather than silently dropped: a caller that believes it captured the full enumeration and silently got the filtered one is worse off than one that was told no — the same reasoning [create-time `permissions`](./access-control.md#delegation-principal-and-subject) is refused under delegation rather than quietly stripped.

## The feed matches `query()`

An unlisted Record that emits a change event to a default subscriber is not unlisted — so `subscribe()`'s default exclusion and `includeUnlisted` opt-in mirror `query()`'s exactly, including the owner-only gate on the opt-in. The one wrinkle is the transition itself: marking a Record unlisted must still reach a subscriber who already knows it, so it can drop its copy, even though the Record's new state would otherwise fail that same exclusion. See [Change events § The unlisted transition](./events.md#the-unlisted-transition) for the full transition table and the `list`/`unlist` change ops.

## What this is not

**Not a fourth `Permission` variant.** `Permission` is a union over mutually exclusive answers to "who may read this"; `unlistedAt` is orthogonal to that question, not another answer to it, and composes with any permission tier — public-and-unlisted (a bonus post) and owner-only-and-unlisted are both coherent, meaning different things.

**Not per-audience.** There is no `Listing[]` parallel to `Permission[]` — enumeration does not vary by who is asking, the way reach does. A record is unlisted for everyone or for no one; if a future need for audience-varying enumeration arises, that is new surface, not a reinterpretation of this field.

**Not a query filter for the excluded half.** `RecordFilter` has no negation, so `includeUnlisted: true` returns _both_ listed and unlisted Records together — there is no "unlisted only" filter. A consumer that needs to tell them apart checks `unlistedAt` on the results it gets back.
