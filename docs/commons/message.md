# `org.haverstack/message@1` — Message

> **Status:** Proposed — awaiting an intended writer (a group-discussion app or an
> email-list bridge). Lives in the group cluster: designed for collaborative group
> stacks, meaningful in personal stacks too.

A message on a group's board: a thread starter or a reply. The model is deliberately
**message-board-shaped, not chat-shaped** — subject + body + flat replies, the way
small groups actually use Slack (as a slow message board) and the way email lists have
worked for fifty years. Presence, typing indicators, and ephemerality are chat-app
concerns and have no representation here.

**This is not the social post.** A `message` is addressed to a group by living in that
group's stack; a social post is broadcast to the world under a public identity. The
broadcast shape is its own type — see [Choosing a text type](./text-types.md) — and
nothing here forecloses it: the two differ in contract, not in fields.

Messages are **sent** — speech addressed to others, whose meaning is indexed to its
moment and thread. For the boundary with `note` (kept) and `article` (published), see
[Choosing a text type](./text-types.md).

Prior art: RFC 5322 (email — subject/body/references), Usenet, Discourse topics,
Basecamp's message board.

## Schema

```ts
await stack.defineType('org.haverstack/message@1', 'Message', {
  text: { kind: 'text', required: true },
  subject: { kind: 'string' },
  format: { kind: 'string' },
});
```

## Field semantics

| Field     | Kind     | Required | Meaning                                                                                                                                |
| --------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `text`    | `text`   | yes      | The body.                                                                                                                              |
| `subject` | `string` | no       | Thread subject. Conventionally present on thread starters, absent on replies (a reply that sets one is a subject change, as in email). |
| `format`  | `string` | no       | Same vocabulary and defaults as `note`: `"markdown"` (default), `"plain"`.                                                             |

The author is `entityId` — set natively by `ScopedStack.create()` for every member
write, which is the whole reason this type needs no author field.

## Conventions

- **Threading is `parentId`, flat — and any record can anchor a thread.** A board
  thread's anchor is a message with no parent; a comment section's anchor is the record
  being discussed — comments on a blog post are messages parented to the `article`,
  and the same move gives photos, polls, and events their discussions. Replies set
  `parentId` to the anchor. The thread view is one indexed query
  (`parentId = <anchor>`, sort `createdAt` asc); the board index is another
  (`typeId = message@1, parentId = null`, which finds exactly the threads that _are_
  board threads). Basecamp-style flat threads are the model.
- **Replying to a specific earlier message** (quoting) adds
  `{ kind: 'relationship', label: 'reply-to', recordId }` on top of `parentId` — the
  spec's own example association, used here for precision, not structure.
- **Attachments**: attachment associations, any label; `embed` for files referenced
  from the body, per the cross-type convention.
- **Edits** are ordinary updates — version history is the edit trail, for free.
  Deletions are soft, recoverable by the group owner per the recoverability model.
- **Read/unread** is each member's perspective — app-side state, never on the record.
- **Boards/categories** beyond one board per stack: app container records as parents of
  thread starters, or a [`folder`](./folder.md).
- **Email-list bridging** is a motivating consumer: subject/body/threading map 1:1 to
  RFC 5322, so a bridge app can mirror a listserv into a group stack (and out), giving
  a group a searchable, owned archive without asking anyone to switch tools on day one.
- **Comments across trust boundaries**: a public blog's comment section is this same
  shape living in the author's personal stack — commenters are entities holding a
  `create` grant on `message@1`. Webmention-grade interop with real primitives
  underneath, practical for strangers because entity identity is a self-certifying DID
  (a public key, nothing else) rather than an account in some directory.

## Read-compat core

```ts
{ text: { kind: 'text', required: true } }
```

Note-compatible, deliberately: a notes app pointed at a group stack can read the
discussion.

## Deliberately excluded

- Social-post semantics — the broadcast contract's territory; see [`post`](./post.md).
- Reactions — a future micro-proposal (likely tag associations by non-authors — which
  needs finer-grained association permissions than today's `update-own`/`update-any`
  grant actions provide).
- Chat features (presence, ephemerality, delivery/read receipts) — out of scope by
  design posture, not by omission.
- `to`/`cc` addressing — presence in the group's stack is the addressing.

## Changelog

- **Proposed** — initial definition: `text` (required), `subject`, `format`.
- **Proposed, amended** — threads may be anchored by any record (comments on articles,
  photos, polls); text-type contract guide cross-referenced.
- **Proposed, amended** — [`post@1`](./post.md) landed, discharging the broadcast-shape
  cross-reference this file previously carried as a forward pointer only.
