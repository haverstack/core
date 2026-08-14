# `org.haverstack/photo@1` — Photo

> **Status:** Draft.

An image as a first-class object — the photo-library / Tumblr-photo-post shape — as
opposed to an image illustrating some other record (which is just an attachment
association on that record). A photo record is "this image is in my library": the
binary plus caption, alt text, and capture time.

The essential field of a photo is the image itself, but type schemas validate `content`
only: a "required attachment association" would be a convention the schema can't
enforce and `isCompatible()` can't see. The `file-ref` field kind fixes exactly this,
making `photo` its first and motivating consumer — the required `image` field below is
schema-enforced, not convention-only.

## Schema

```ts
await stack.defineType('org.haverstack/photo@1', 'Photo', {
  image: { kind: 'file-ref', required: true },
  caption: { kind: 'text' },
  alt: { kind: 'string' },
  takenAt: { kind: 'date' },
});
```

## Field semantics

| Field     | Kind       | Required | Meaning                                                                                                                             |
| --------- | ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `image`   | `file-ref` | yes      | The original image bytes (content-addressed). The photo _is_ this file.                                                             |
| `caption` | `text`     | no       | What the user says about it. Markdown by convention.                                                                                |
| `alt`     | `string`   | no       | Accessibility description of the image content — a property of the image (describes the bytes), not a perspective; travels with it. |
| `takenAt` | `date`     | no       | Capture time (typically from EXIF). Distinct from `createdAt`, which is when the record entered the stack (import time).            |

## Conventions

- **Geotag**: the cross-type `location` relationship to a [`place`](./place.md)
  record — not raw coordinates in content.
- **Albums**: `parentId` to an app's album/container record — same posture as task
  lists and site containers; the photos interop, the album doesn't.
- **Variants** (thumbnails, resizes, edited versions): derived data, not commons
  content — apps regenerate them. A destructive edit is a new photo record; link it
  `{ kind: 'relationship', label: 'derived-from', recordId }`.
- **EXIF beyond `takenAt`** (camera, lens, exposure): excluded from @1; a future
  additive optional `object` field or sidecar, decided when a real writer needs it.
- **Video/audio**: sibling proposals, not a generalized `media` type — photo-specific
  prior art (EXIF, photo libraries) is too good to dilute.

## Read-compat core

```ts
{ image: { kind: 'file-ref', required: true } }
```

## Changelog

- **Draft** — graduated from Staged: the `file-ref` field kind now exists, so `image`
  is schema-enforced as specified, unchanged from the staged design.
- **Staged** — design recorded; registration blocked on the `file-ref` field kind not
  yet existing.
