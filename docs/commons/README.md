# Haverstack Schema Commons

> **Status:** Draft. Staged in `haverstack/core` under `docs/commons/`; to be extracted
> into its own repository once it has users beyond this project. Per the project's
> evolution policy, definitions here change **in place, without version bumps**, until
> there is an install base to break.

Namespaced types (`com.example.myapp/note@1`) give every app its own schema authority —
which is correct, but defaults to silos-within-the-stack. Portability of _bytes_ is
guaranteed by the stack; portability of _meaning_ is not. If a notes app and a
flashcards app each invent their own `note` type, the user's data moves between backends
freely but between apps not at all.

The Schema Commons is the social layer that closes that gap: a small set of well-known,
neutrally-governed types for the data shapes almost every personal app touches. When two
apps speak a commons type, "switch apps without export friction" is literally true — the
second app queries the first app's records and just works.

---

## The commons namespace

The namespace **`org.haverstack`** is reserved for commons types. Every type under it is
defined in this directory and governed by the process below — no app may mint types in
this namespace.

```
org.haverstack/note@1
org.haverstack/bookmark@1
org.haverstack/task@1
org.haverstack/contact@1
```

Everything outside `org.haverstack` (and the `_`-prefixed system types, which belong to
the library) remains app territory, exactly as the spec defines: reverse-DNS namespace,
app author is the authority.

**Canonical definitions.** The schema in each type's file here is the type. Apps must
register commons types exactly as written — a modified copy under the same ID is schema
drift and will (correctly) trip the drift guard against other apps sharing the stack.
Apps never need to extend a commons schema in place:

- **Missing something universal?** Propose the field upstream (see Governance). Additive
  optional fields land in place, so accepted proposals reach every app without a bump.
- **Need something app-specific?** Keep it out of the commons record. Put app-private
  data in the app's own sidecar type and link it with a
  `{ kind: 'relationship', label: '...' }` association to the commons record. The
  commons record stays cleanly interoperable; the sidecar travels with it.

---

## How apps use commons types

Three postures, in order of preference:

1. **Write commons types natively.** If your app's core object _is_ a note, a bookmark,
   a task, or a contact, use the commons type as your storage type. You inherit interop
   with every other commons-speaking app for free.
2. **Design for read-compatibility.** If your domain type is richer than the commons
   type but shares its heart, define your own type such that it satisfies
   `isCompatible(yourSchema, commonsSchema)` — i.e. it carries the commons type's
   required fields with matching kinds. Other apps that consume via `isCompatible()`
   can then read your records even though they've never heard of your type. Each type
   file documents its **read-compat core** — the minimal shape consumers should code
   against.
3. **Migrate in later.** An existing app with its own type can add a lens to the commons
   type when ready; the library's migration machinery only covers versions of the _same_
   type, so this is an app-level export/import — which is still a one-time cost paid by
   the app author, not a per-user export ritual.

Consumers should filter by exact `typeId` when they need commons semantics, and use
`isCompatible()` with the read-compat core when they want maximum reach.

---

## Design rules for commons types

Distilled from the project's design decisions of record; proposals are evaluated against
these.

1. **Minimal required core.** A field is `required` only if the type is meaningless
   without it (`note.text`, `bookmark.url`, `task.title`, `contact.name`). Everything
   else is optional. The required core doubles as the read-compat contract, so every
   required field is a tax on compatibility.
2. **Additive evolution; bumps are rare and semantic.** New optional fields land in
   place at the current version. A version bump happens only when a field becomes
   required (with real backfill), changes meaning, or the shape restructures.
   Accumulating many optionals is the named smell that a consolidating bump is due.
3. **Properties, not perspectives.** Content fields describe the thing itself. Anything
   that is one app's or one user's _view_ of the record — pinned, starred, read/unread,
   sort order, UI state — is not commons content. Use tag associations or app sidecar
   types.
4. **Queryable fields are top-level scalars.** Only top-level scalar fields support
   content filtering, so anything apps will plausibly filter on (`task.done`) must not
   be nested. Arrays and objects are for data that is only ever read, not queried.
5. **Use the native machinery, don't duplicate it in content.** Tags are tag
   associations, not a `tags: string[]` field. Cross-references are relationship
   associations or `parentId`, not bare ID strings in content. Files are attachment
   associations. Authorship is `entityId`; timestamps are `createdAt`/`updatedAt` —
   never mirrored into content.
6. **Well-known association labels are part of the type.** Where a type has a
   conventional attachment or relationship (a contact's `avatar`, a bookmark's
   `snapshot`), the label is specified in the type file with the same authority as a
   schema field.
7. **String vocabularies over booleans-in-waiting.** Where a field has a small open set
   of values (`note.format`), the type file specifies the well-known values and the
   default meaning of absence; unknown values must be tolerated by readers
   (treat-as-default), so the vocabulary can grow additively.

---

## Governance

Lightweight by design, sized for a project with one maintainer and zero budget. The
process is the point — it makes "neutrally governed" true from day one — but it must
never be heavier than the work it governs.

**Proposing a new type or field.** Open an issue on `haverstack/core` titled
`Commons: <proposal>` covering:

- **Motivation** — what interop becomes possible; which real app or demo intends to
  write it. Proposals without a concrete intended writer are parked, not rejected.
- **Schema** — full `TypeSchema` for new types; the new field for additions.
- **Semantics** — meaning of each field, defaults on absence, well-known association
  labels.
- **Prior art** — the shape this data takes elsewhere (vCard, iCalendar, Netscape
  bookmarks, todo.txt, ATProto lexicons…). We steal proven shapes; we don't invent.
- **Evaluation against the design rules above.**

Discussion happens on the issue; the accepted result is a PR to this directory. Each
type file carries a changelog so decisions stay attached to the schema they shaped.

**Changing an existing type.** Additive optional fields follow the same process and land
in place. Anything that would bump a version is an `RFC:` issue, per the project's
convention — expected to be rare enough that each one is an event.

**Authority.** The project maintainer is the final arbiter. This is a bootstrapping
posture, not a constitution: when multiple independent apps ship commons types, the
people maintaining those apps are the natural successor body, and this section should be
rewritten by and for them.

---

## The initial set

Four types, chosen because they are the shapes nearly every personal-software ecosystem
re-invents first, and because pairs of them make the interop story demonstrable (notes ↔
flashcards, bookmarks ↔ read-later, tasks ↔ calendar/agenda).

| Type                        | File                           | Read-compat core  |
| --------------------------- | ------------------------------ | ----------------- |
| `org.haverstack/note@1`     | [`note.md`](./note.md)         | `{ text }`        |
| `org.haverstack/bookmark@1` | [`bookmark.md`](./bookmark.md) | `{ url }`         |
| `org.haverstack/task@1`     | [`task.md`](./task.md)         | `{ title, done }` |
| `org.haverstack/contact@1`  | [`contact.md`](./contact.md)   | `{ name }`        |

Deliberately absent from the initial set: `event` (recurrence rules deserve their own
proposal, not a rushed subset), `message`/`post` (social shapes should be reconciled
with the ATProto-compat RFC, #15), and `file`/`document` (largely covered by the
attachment machinery plus `note`).

---

## Planned tooling

A `@haverstack/commons` package that exports the canonical schemas as constants and a
`defineCommonsTypes(stack, [...])` helper, so "register the type exactly as written"
is a one-liner and drift is structurally impossible. Not started; the definitions in
this directory are authoritative until it exists.
