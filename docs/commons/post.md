# `org.haverstack/post@1` — Post

> **Status:** Draft.

A broadcast utterance: a short, untitled piece of speech published under a public
identity, addressed to whoever listens rather than to a bounded audience. Completes the
fourth cell of the artifact/speech × bounded/unbounded 2×2 in
[Choosing a text type](./text-types.md#the-fourth-contract-posts-are-broadcast) —
artifact/unbounded is `article`/`page`, speech/bounded is `message`, speech/unbounded is
`post`.

**Not the IndieWeb's "note."** Their note is our `post`; see
[On the names](./text-types.md#on-the-names) for why the commons keeps its own names
despite the collision with IndieWeb post-type discovery and ActivityStreams 2.0's `Note`.

Posts are **broadcast** — speech constituted by the act of publishing, under a
self-certifying identity, to an audience the stack has no boundary around. For the
boundary with `note` (kept), `message` (sent to a bounded audience), and `article`
(published as a named work), see
[Choosing a text type](./text-types.md).

## Schema

```ts
await stack.defineType('org.haverstack/post@1', 'Post', {
  text: { kind: 'text', required: true },
  format: { kind: 'string' },
  url: { kind: 'string' },
});
```

## Field semantics

| Field    | Kind     | Required | Meaning                                                                                                                                                                                                       |
| -------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`   | `text`   | yes      | The utterance. What the post _is_.                                                                                                                                                                            |
| `format` | `string` | no       | Same vocabulary and defaults as `note`: `"markdown"` (default when absent), `"plain"`; unknown values render as plain.                                                                                        |
| `url`    | `string` | no       | Canonical location. POSSE's premise is that the canonical copy lives on your own site; the publishing app stamps it at first publish, same convention as `article.url`. Syndicated copies never overwrite it. |

The author is `entityId` — set natively by `Stack.create()`/`ScopedStack.create()`. No
`author` string: unlike `article`, a post is never a captured work carrying someone
else's byline.

### No date field, deliberately

The commons applies a consistent rule: a content date earns its place by naming an
event `createdAt` doesn't (`photo.takenAt` is capture vs. import, `article.publishedAt`
is publication vs. drafting). For a broadcast utterance, **uttering is creating** — an
unsaid post is working material, not a post, which is the same reasoning that leaves
`message@1` with no date field. A `publishedAt` here would equal `createdAt` on
essentially every record ever written, which design rule 5 forbids by name
(_"timestamps are `createdAt`/`updatedAt` — never mirrored into content"_).

This makes native `createdAt` the only ordering key a post will ever have. Importing an
existing archive of dated posts therefore depends on
[#203](https://github.com/haverstack/core/issues/203) (settable `createdAt` for
owner-side imports on unscoped `Stack`) — a dependency on _importing into_ the type, not
on the type's definition, which is fully expressible today.

**Scheduled posts**, the strongest objection to no date field: the position taken here
is that scheduling is the scheduler's state, not the utterance's — a queued post is
working material inside a tool until it goes out, and its moment is when it went out.
If that proves wrong in practice, an optional date field lands in place with no version
bump; starting with a mirror field and later removing it would be the expensive
direction.

## Conventions

- **Threading**: `parentId` for in-stack anchoring, as `message` does. Cross-stack
  replies — a reply living in the replier's stack, referencing a record in someone
  else's — are a relationship's `target` union
  (`{ scope: 'record', recordId, stackUrl }` / `{ scope: 'external', ns, id }`), not
  `parentId`, and need no change here; see
  [Choosing a text type § The fourth contract](./text-types.md#the-fourth-contract-posts-are-broadcast).
- **Embedded media**: attachment associations labeled `embed`, per the cross-type
  convention.
- **Geotagging**: the cross-type `location` relationship to a [`place`](./place.md)
  record — the Foursquare-style public check-in is `post` + `location`.
- **Tags**: tag associations, never a content field.
- **Syndication**: a bridge publishes a copy elsewhere and stamps a `syndicated-to`
  relationship with an external target on the canonical record; see
  [Cross-type conventions](./README.md#cross-type-conventions). The canonical copy is
  this record; syndicated copies never own `url`.
- **Authorship**: `entityId`. Deletion inside the stack is recoverable as usual; once a
  post has been syndicated, deletion of the broadcast copy is a request to the network,
  not a guarantee — a caveat of syndication, not of this type.

## Prior art

IndieWeb post-type discovery (their "note"), ActivityStreams 2.0 `Note`,
`app.bsky.feed.post`, Mastodon status, Twitter.

## Read-compat core

```ts
{ text: { kind: 'text', required: true } }
```

Shared with `note`, `message`, and `article` by design — generic text consumers reach
all four via `isCompatible()`; the `typeId` is the contract signal for consumers that
honor it.

## Deliberately excluded

- `createdAt`/`updatedAt`/a `publishedAt` mirror — see "No date field, deliberately"
  above.
- `tags: string[]` — tag associations exist.
- `author` string — a post is never a captured work with someone else's byline;
  `entityId` is the author.
- `to`/`cc` addressing, reply-count, like-count and similar network-derived fields —
  bridge/adapter territory, not properties of the utterance itself.
- `lexiconId` mapping, content addressing, tombstone semantics — bridge machinery
  (`adapter-atproto` and friends), not a content schema concern.

## Changelog

- **Draft** — initial definition: `text` (required), `format`, `url`.
