# `org.haverstack/image@1` — Image

> **Status:** Draft.

An image as a first-class object — the photo-library / Tumblr-photo-post shape — as
opposed to an image illustrating some other record (which is just an attachment
association on that record). An image record is "this image is in my library": the
binary plus caption, alt text, and capture time. Photos, paintings, drawings, scans, and
screenshots are all images; the type names the medium an app renders, not how the
picture was made.

The essential field of an image record is the file itself, but type schemas validate
`content` only: a "required attachment association" would be a convention the schema
can't enforce and `isCompatible()` can't see. The `file-ref` field kind fixes exactly
this, making `image` its first and motivating consumer — the required `file` field below
is schema-enforced, not convention-only.

## Schema

```ts
await stack.defineType({
  id: 'org.haverstack/image@1',
  name: 'Image',
  schema: {
    file: { kind: 'file-ref', required: true },
    caption: { kind: 'text' },
    alt: { kind: 'string' },
    capturedAt: { kind: 'date' },
  },
});
```

## Field semantics

| Field        | Kind       | Required | Meaning                                                                                                                                                                   |
| ------------ | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`       | `file-ref` | yes      | The original image bytes (content-addressed). The record _is_ this file.                                                                                                  |
| `caption`    | `text`     | no       | What the user says about it. Markdown by convention.                                                                                                                      |
| `alt`        | `string`   | no       | Accessibility description of the image content — a property of the image (describes the bytes), not a perspective; travels with it.                                       |
| `capturedAt` | `date`     | no       | When the image was captured — shot, scanned, or screenshotted (typically from EXIF). Distinct from `createdAt`, which is when the record entered the stack (import time). |

## Conventions

- **Geotag**: the cross-type `location` relationship to a [`place`](./place.md)
  record — not raw coordinates in content.
- **Albums**: `parentId` to an app's album/container record — same posture as task
  lists and site containers; the images interop, the album doesn't.
- **Variants** (thumbnails, resizes, edited versions): derived data, not commons
  content — apps regenerate them. A destructive edit is a new image record; link it
  `{ kind: 'relationship', label: 'derived-from', recordId }`.
- **EXIF beyond `capturedAt`** (camera, lens, exposure): excluded from @1; a future
  additive optional `object` field or sidecar, decided when a real writer needs it.
- **Artwork metadata** (when a painting was made, medium, dimensions): not image
  properties — `capturedAt` on a scanned painting is the scan, not the painting. A
  sibling type if a real writer needs it.
- **Video/audio**: sibling types, not a generalized `media` type — the type, not the
  attached file's MIME type, tells an app which player or container to render.

## Read-compat core

```ts
{ file: { kind: 'file-ref', required: true } }
```
