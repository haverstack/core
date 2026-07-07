# `org.haverstack/folder@1` — Folder

> **Status:** Proposed — awaiting an intended writer (a shared-drive app). Lives in the
> group cluster.

A user-created, app-neutral container — the thing that makes a shared drive a drive.
The stack already provides everything else a "docs & files" tool needs: attachments are
content-addressed blobs with metadata records, notes/articles are documents, `parentId`
is indexed containment. What's missing is only a container type every app agrees on.

**Boundary with app containers, stated carefully.** The commons doctrine so far has
been "containers are app territory" (task lists, photo albums, site containers) — those
containers carry app-specific semantics (a list's sort order, an album's cover). A
`folder` is different in kind: it has _no_ semantics beyond named containment, and its
entire purpose is to be shared structure that no single app owns. The doctrine becomes:
**app-meaningful containers stay app types; meaning-free shared containment is
`folder`.** An app may parent its own container record inside a folder tree, and apps
with folder-shaped needs (a drive, a shared notebook) should use `folder` rather than
minting a private equivalent.

Prior art: every filesystem; WebDAV collections; the shared-drive folder trees of
Google Drive/Dropbox.

## Schema

```ts
await stack.defineType('org.haverstack/folder@1', 'Folder', {
  name: { kind: 'string', required: true },
  description: { kind: 'text' },
});
```

## Field semantics

| Field         | Kind     | Required | Meaning                                                                                           |
| ------------- | -------- | -------- | ------------------------------------------------------------------------------------------------- |
| `name`        | `string` | yes      | The folder's name as displayed. Siblings sharing a name is legal but unkind; writers should warn. |
| `description` | `text`   | no       | What belongs here — the README taped to the front of the drawer.                                  |

## Conventions

- **Containment is `parentId`**, for both subfolders and contents. Any record type can
  live in a folder — a drive holding notes, photos, polls, and plain files is the
  intended picture, not an edge case.
- **A "file" in the drive** is, today, any record carrying an attachment association —
  typically a `note` with the file attached and the body as commentary. A first-class
  `file` type (a required `file-ref` plus name) is expected to follow
  [`photo`](./photo.md)'s pattern once #63 lands; this file's conventions will be
  amended then.
- **Folder-level permissions do not exist** — permissions are per-record and grants are
  per-type; a folder's `permissions` field governs the folder record itself, **not**
  its contents. Apps must not present a folder as an access boundary unless they also
  set permissions on every contained record. Recorded bluntly because every user will
  assume otherwise; whether reference-implies-access (#51) or a future inherited model
  changes this is an open question for the permissions work, not something this type
  can promise.
- **Moving** is re-parenting — one field write, atomic, history preserved.

## Read-compat core

```ts
{ name: { kind: 'string', required: true } }
```

(Shared with `contact`'s core — `isCompatible` reach is deliberately generous here;
consumers wanting real folders filter by `typeId`.)

## Deliberately excluded

- Sort order, view mode, color, icon — perspectives; app-side or sidecar.
- Folder-level sharing semantics — see conventions; being honest about this is the
  feature.
- Paths/slugs — folders are display structure, not addresses; [`page`](./page.md) is
  the type whose tree builds URLs.

## Changelog

- **Proposed** — initial definition: `name` (required), `description`.
