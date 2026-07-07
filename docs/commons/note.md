# `org.haverstack/note@1` — Note

> **Status:** Draft.

A piece of free-form written content: a note, a journal entry, a draft, a text snippet.
The most universal shape in personal software, and the anchor of the commons — the
spec's own `isCompatible()` example ("any Type with `{ text: string }`") is this type's
read-compat core.

Notes are **kept** — working material written by and for the writer, where the writer
may be a group (a shared stack's collectively maintained minutes and how-tos are still
notes). For the boundary with `article` (published) and `message` (sent), see
[Choosing a text type](./text-types.md).

## Schema

```ts
await stack.defineType('org.haverstack/note@1', 'Note', {
  text: { kind: 'text', required: true },
  title: { kind: 'string' },
  format: { kind: 'string' },
});
```

## Field semantics

| Field    | Kind     | Required | Meaning                                                                                                                                                                                                                                               |
| -------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`   | `text`   | yes      | The body. What the note _is_.                                                                                                                                                                                                                         |
| `title`  | `string` | no       | Display title. Absent means untitled; readers may derive one from `text` (e.g. first line) for display, but must not write the derivation back.                                                                                                       |
| `format` | `string` | no       | How `text` should be interpreted. Well-known values: `"markdown"` (CommonMark), `"plain"`. **Absent means `"markdown"`.** Readers encountering an unknown value must fall back to rendering as `"plain"` — never guess a richer format than declared. |

## Conventions

- **Organization**: `parentId` for containment (notebook/folder records, when an app has
  them); tag associations for flat labels. Pinning, starring, and read-state are
  perspectives — tags, not content.
- **Embedded files**: images and other media referenced from `text` are attachment
  associations with label `embed` — see the cross-type conventions in the
  [README](./README.md). How the body refers to an embedded file (e.g. a markdown
  image reference) is app territory in @1; a commons convention here is an expected
  follow-up proposal once `file-ref` fields (#63) land.
- **Cross-references**: a note that is _about_ another record (annotating a bookmark, a
  contact) uses `{ kind: 'relationship', label: 'about', recordId }`.

## Read-compat core

```ts
{ text: { kind: 'text', required: true } }
```

Consumers wanting maximum reach should accept any type compatible with this shape and
treat `title`/`format` as optional enrichments. Note that `text` ⇄ `string` are mutually
readable under the strengthened `isCompatible` relation (#54), so short-string types
also qualify.

## Deliberately excluded

- `createdAt`/`updatedAt`/author fields — native record fields cover these.
- `tags: string[]` — tag associations exist.
- `pinned`, `archived`, `color` — perspectives; app sidecar or tags.
- Rich-text formats beyond markdown/plain (HTML in particular) — HTML notes are an
  XSS-shaped liability the dangerous-type work (#66) exists to avoid; apps holding HTML
  should convert on write.

## Changelog

- **Draft** — initial definition: `text` (required), `title`, `format`.
