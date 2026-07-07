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
social shape (reposts, mentions, public replies) belongs to the ATProto-compat RFC
(#15) and is still deferred; this type must not foreclose it, and reconciliation is
expected when #15 lands.

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

- **Threading is `parentId`, flat.** A thread starter has no message parent; replies
  set `parentId` to the starter. The thread view is one indexed query
  (`parentId = <starter>`, sort `createdAt` asc); the board index is another
  (`typeId = message@1, parentId = null`). Basecamp-style flat threads are the model.
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

## Read-compat core

```ts
{ text: { kind: 'text', required: true } }
```

Note-compatible, deliberately: a notes app pointed at a group stack can read the
discussion.

## Deliberately excluded

- Social-post semantics — #15 territory (see above).
- Reactions — a future micro-proposal (likely tag associations by non-authors — which
  needs the association-permission rules from the #57/#58 reshape to settle first).
- Chat features (presence, ephemerality, delivery/read receipts) — out of scope by
  design posture, not by omission.
- `to`/`cc` addressing — presence in the group's stack is the addressing.

## Changelog

- **Proposed** — initial definition: `text` (required), `subject`, `format`.
