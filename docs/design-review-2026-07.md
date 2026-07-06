# Haverstack Design Review — Milestone Handoff

Conclusion artifact for the design-review collaboration on `haverstack/core` (two sessions, issues #45–#69). The backlog is fully drained: every finding is filed, folded into an existing issue, or resolved by a decision recorded on the relevant thread. Upload this into a new session to resume — the next phase is implementation.

## The project

Haverstack is a portable personal data stack: apps write typed **Records** into a user-owned **Stack** through a single library, agnostic of storage backend. Monorepo (`pnpm` workspaces) at `haverstack/core`:

- `packages/core` — `Stack` class, `ScopedStack` (permission-enforcing view via `asEntity()`), types, schema/validation, Crockford base-32 ID generation, `combineAdapters()`, `MemoryAdapter` test helper
- `packages/record-adapter-sqljs` — sql.js (SQLite/WASM) `StackRecordAdapter` + bearer-token store
- `packages/blob-adapter-disk` — content-addressed (SHA-256) blob storage
- `packages/adapter-local` — convenience wrapper (SQLite records + disk blobs)
- `packages/adapter-api` — HTTP client adapter for stack servers
- `packages/wire-types` — wire serialization shapes
- `docs/spec.md` — the design spec (data model, permissions/grants, migrations, wire format)
- Related: `haverstack/server` (reference server, separate repo)

## How we work

1. Reviewer raises design flaws → owner (cuibonobo) adds intent/context → discuss until a direction is agreed → file a GitHub issue capturing problem, decided direction, work items, open questions, cross-refs.
2. Issues that change spec _semantics_ are titled "RFC: …". Mechanical/implementation issues are plain titles.
3. Discussion first, filing second — don't file until the owner says so. Follow-up analysis (perf, clarifications) is posted as issue comments so decisions live on the tracker.
4. Lead with the verdict; cite prior art when it earns its place (Stripe versioning, Cambria lenses, protobuf/ATProto additive evolution, SSB/Nostr key identity, petnames/Zooko's triangle).

## Owner-stated design intent (constrains everything)

- **Scale**: individuals and small cohesive groups per stack. Hundreds of principals is explicitly NOT a goal.
- **Topology**: multi-app access goes through a server (`adapter-api`, possibly localhost). Direct file access via `adapter-local` = full trust, single process, expert/embedded only. The permission model only means anything behind a server.
- **Versioning intent**: rollback + soft-delete recovery. Conflict safety is opt-in (#48).
- **Identity**: no central provider. Cryptographic self-certification, DID syntax, `did:key` floor (#49).
- **Performance**: reads must stay cheap/fast; writes can and should be slower.
- **Ecosystem**: doesn't exist yet — standardize contracts now while it's cheap. No install base beyond the owner → **schema/wire changes land in place, no version bumps, until there's someone to break** (#57).

## Design philosophy (decisions of record — the durable output of this review)

1. **Layering**: adapters are storage engines; `Stack` is the library's _invariant_ layer (schema validation, `_config` protection, drift guard, ID legality); `ScopedStack` is per-requester policy. Invariants are written once in core and inherited by every adapter. The one exception: query-shape rules (system-record exclusion) must be pushed down into adapters for pagination correctness — so they're promoted from convention to specced contract enforced by shared conformance fixtures. (#67, #68, #52)
2. **Recoverability over fencing**: record-level `write` stays one coarse bit; its trust model is "anything a write-holder does, the owner can undo." Irreversible or privilege-bearing verbs (hard delete, `setPermissions`) are owner/creator-only. Grants stay fine-grained — type-wide access for third-party apps warrants verb precision; per-record sharing among intimates warrants simplicity. (#59)
3. **One versioning rule**: every record mutation — content, associations, permissions, soft-delete/undelete — bumps `version` and snapshots the prior full state (`RecordVersion` gains `associations`/`permissions`/`typeId`). No special cases; `ifVersion` CAS then covers all races. Restore returns content + typeId + associations, never permissions. (#61, #62, #48)
4. **Soft-deleted records count as references** — nothing reachable from a recoverable state gets destroyed (blob GC, undelete). Only hard deletion removes a reference. (#64, #60)
5. **Additive-in-place is the staging area; version bumps are consolidation points.** New optional fields land in place (undefined-checks are a property of data, not of evolution policy — an identity-migration bump removes none of them). Bump when a field becomes required (with real backfill), meaning changes, or shape restructures. Many-optionals = named smell that a consolidating bump is due. Version numbers are rare and semantic. Mechanically enforced by the drift guard: `schemaHash` is a fast-path equality check; `diffSchemas` is the judge (additive → accept in place; anything else → `StackSchemaDriftError`, "bump the version"). (#47 + its two amendment comments, #68)
6. **Two compatibility relations, never conflated**: `isCompatible` = read-compatibility ("may a consumer of this shape read records of that type"; requires required-on-candidate; `text`⇄`string` mutually readable) vs `diffSchemas` = evolution legality ("may this schema replace that one under the same id"; kind changes are always drift). (#54, #68)
7. **Wire honesty**: never silently widen or narrow a query — missing capability fails loudly (#56); errors round-trip as typed core classes via a wire `code` vocabulary (#53); malformed input is 400, invalid content is 422; the #52 conformance fixtures (run by both `adapter-api` and `haverstack/server`) are the enforcement point for every wire contract decided in this review.
8. **Server-authoritative envelope**: `version`/`updatedAt` (#48) and ID legality (charset, length, reserved `_` prefix, duplicate → 409) (#55) are audited server-side; clients keep generating IDs (offline-friendly) but the server validates always, may assign optionally.
9. **Properties vs perspectives**: fields that describe _the bytes/the world_ are singular and deterministic (attachment `mimeType`: first-recorded wins, conflicts rejected); fields that describe _someone's view_ are plural and per-requester (attachment `filename`, entity petnames in #49's `_entity` cards). (#65, #49)
10. **Determinism + backstop pairing**: make behavior deterministic first (#65 Content-Type), then make even a deterministic lie inert (#66 forcing applies to the _resulting_ type from any source, safe-list + `nosniff`). Neither substitutes for the other.
11. **`entityId` means author, everywhere** — never grantee (#57), never stamped on owner writes through any path (#69), and becomes a DID string under #49.

## Issues index

**Prior session (#45–#52):**

- #45 single-writer storage model + topology guidance; #46 SQLite split (native adapter, browser sqljs, shared SQL layer, `StackTokenStore`) — accumulated implementation comments: transactions for `deleteAttachment` race (metadata in tx, bytes after commit), `PRAGMA foreign_keys`, token storage out of the portable file; #47 owner-driven migration + additive evolution — amended twice by comment: `migrateAll()` sweeps soft-deleted unconditionally; governance (staging area / consolidation points); #48 opt-in optimistic concurrency — parked question resolved by #61; #49 RFC identity = DID; #50 pagination-as-exhaustive; #51 ScopedStack.create passthrough / reference-implies-access gating; #52 PATCH contract split + conformance fixtures.

**This session (#53–#69):**

- #53 error taxonomy round-trip (wire `code` vocabulary; + comment: malformed cursors → 400)
- #54 `isCompatible` strengthening (required-on-candidate, `text`⇄`string` table — clarifying comment with the full relation, recursive descent)
- #55 ID authority (server validates always/assigns optionally; `% max` off-by-one; clock-regression clamp)
- #56 wire gaps (`relatedTo.label`, silent content-filter drop → throw, DELETE-with-body, `maxAttachmentBytes` in discovery, type cache per write)
- #57 grantee out of `entityId` into `GrantContent` (+ comment: `listGrants`/`revoke` official scope)
- #58 group roles: admin = "can manage the group" (role-gated `_group` mutations via #51's predicate, optional `role` on ACL entries, creator-is-first-admin)
- #59 `write` stays one bit + recoverability model (hard delete owner-only — standalone one-line fix at `ScopedStack.delete`)
- #60 undelete API (returns record, idempotent, `requireDeletable` gate, no migration at undelete)
- #61 one versioning rule (full-state snapshots)
- #62 `restoreVersion` validates against the snapshot's own typeId and restores it (stale-is-legal, `migrateAll` heals)
- #63 `file-ref` field kind (content references become real; blocks #64)
- #64 orphaned blob GC (owner-invoked sweep, dry-run, grace period, `BlobAdapter.listFiles()`)
- #65 deterministic attachment `mimeType` (first-recorded wins; filenames stay perspectives)
- #66 dangerous-type forcing covers all three Content-Type sources (safe-list, `nosniff`)
- #67 `_config` protection (no delete, no `entityId` change; exclusion promoted to contract)
- #68 schema-drift guard (`diffSchemas` + `StackSchemaDriftError`; fixes `seedSystemTypes` churn)
- #69 polish batch (owner `entityId` normalization, optional `timezone`, ISO 8601 dates, `content: { x: null }` semantics)

Pre-existing owner issues: #3 (event/hook system), #15 (RFC: ATProto compat — reshaped by #49), #16 (RFC: discriminated union for relationship targets).

## Open questions flagged for implementation time (none block filing; all recorded on their issues)

- #48: 409 vs 412 for `ifVersion` conflicts.
- #49/#58: who may act _as_ a group (key custody) — deferred; #58's admin definition must not foreclose it.
- #53: does 400 get a typed core error or stay adapter-level (leaning adapter-level).
- #55: `createdAt` server-authoritative in the same pass? Retry-on-409 automatic in `create()`? Timestamp-prefix skew tolerance is server-optional.
- #59: does `delete-any` (grant) also lose hard delete (leaning yes)? Non-owner `{ hard: true }` → error or silent soften (leaning error)?
- #49 follow-up: ownership transfer as a deliberate API (per #67, never a `_config` field write).

## Suggested implementation order (dependency-driven, not mandated)

1. **Standalone, land anytime**: #59's hard-delete carve-out; #55's two `id.ts` bug fixes; #69 items; `seedSystemTypes` idempotency via #68's no-op branch.
2. **Keystone**: #46 (native adapter, shared SQL layer, transactions) — #48 atomicity, #61's atomic snapshot+mutate, #63's indexing, #67's shared exclusion, and #53's cursor codec all land in or on it.
3. **Contract backbone**: #52 fixtures + #53 error vocabulary early — nearly every subsequent issue pins behavior there.
4. **Chains**: #47 (`RecordVersion.typeId`, `migrateAll`) → #62; #61 → #60/#59 spec language; #63 → #64; #65 → #66 (either order works, pair them); #54 → before #47's spec language ships.
5. **Big rocks on their own clock**: #49 (identity), #57/#58 (grant/group reshape — after #61 so mutations are audited).

## What was judged well-designed (for balance)

Record/blob adapter split + `combineAdapters`; content-addressed blobs; cursor pagination; 403-vs-404 distinction; `total: null` cardinality-leak prevention; FTS query sanitizer; the spec's honesty about its own gaps. Added this session: per-requester attachment filenames (already in spec — affirmed and generalized into the properties/perspectives principle); the `?contentType` dangerous-type forcing (right instinct, now extended to all sources); the `setPermissions` owner/creator carve-out (unexplained special case, now the pattern's first instance).

## State of the collaboration

Design review is **complete** — no undiscussed findings remain. Nothing was pushed to any branch; the deliverable is the tracker (#45–#69) plus this document. Next phase is implementation, where the working mode shifts: issues carry decided directions and work items, so sessions can implement directly, with the open questions above resolved with the owner as they're reached.
