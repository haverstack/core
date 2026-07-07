# Choosing a text type — note, article, message

> **Status:** Draft guide. Companion to [`note.md`](./note.md), [`article.md`](./article.md),
> and [`message.md`](./message.md); this document is the tiebreaker when a text record
> could plausibly be more than one of them.

Three commons types carry free-form text, and their schemas are nearly identical —
`note` and `message` differ by one optional string; `article` adds a required title.
That is not a gap to be closed with more fields, because the distinction between them
was never structural. **The `typeId` records the social contract: what was _done_ with
the text, not what the text is.** The same paragraph can legitimately exist under all
three types, and the type is what tells every other app how to treat it.

## The three contracts

> **Notes are kept. Messages are sent. Articles are published.**

- A **note** is _working material_: kept by and for the writer. Its current state is
  the record; editing forever is its normal mode; nobody receives it. In a group stack
  **the group is the writer** — collectively maintained documents (meeting minutes, a
  "how to open the clubhouse" how-to) are still notes, because they are the group's own
  working material.
- A **message** is _speech_: addressed to others as a move in a conversation. Its
  meaning is indexed to its moment and its thread — `createdAt` is part of the content's
  meaning ("when you said it") — and editing after others have read it is tampering
  (edits are corrections, and versioning keeps them honest).
- An **article** is _a work_: composed to be read as a standalone, named thing, with a
  publication lifecycle (draft → published). Its published state is what matters; the
  byline and canonical URL exist because a work is _presented_ to readers, not sent to
  recipients.

## The test — ordered, which is what resolves the hard cases

1. **Was it sent into a conversation?** → `message`
2. **Is it published, or meant to be, as a named work?** → `article`
3. **Otherwise** → `note`

The ordering does real work. A journal entry is time-indexed and never edited —
message-_like_ — but it is addressed to no one, so step 1 fails and it lands at `note`:
temporality alone doesn't make speech; **address does**. A newsletter issue is
literally _sent_, but not conversationally — recipients are not parties to a thread and
its meaning doesn't depend on a position in one — so it passes through step 1 and lands
at `article`: sending-as-distribution is not sending-as-speech.

Likewise, "has a title" is necessary for `article` but not sufficient: a note may be
titled ("2026-07 meeting minutes") without becoming a work. What makes an article is
that being read as a finished work is its purpose.

## What the clock and the edit button mean

|           | Meaningful time                    | What editing means               |
| --------- | ---------------------------------- | -------------------------------- |
| `note`    | none — current state is the record | the point                        |
| `message` | `createdAt` — when it was said     | correction; visible via versions |
| `article` | `publishedAt` — deliberate         | revision/errata once published   |

## Worked examples

| Case                                         | Type                         | Why                                                                                      |
| -------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| Comment on a blog post                       | `message`                    | Sent into a shared space, anchored to the post (`parentId` → the article), time-indexed. |
| Private marginalia while reading             | `note` (+ `about` rel.)      | Kept, not sent — your annotation, invisible to the conversation.                         |
| Draft blog post                              | `article` (no `publishedAt`) | Already a work-in-becoming; drafthood is a lifecycle stage, not a different type.        |
| Scribbled idea for a post                    | `note`                       | Working material; promote to `article` later (new record, `derived-from` relationship).  |
| Journal / diary entry                        | `note`                       | Time-indexed but addressed to no one — address, not temporality, makes speech.           |
| Memoir chapter it becomes                    | `article`                    | Now a named work for readers.                                                            |
| Newsletter issue                             | `article`                    | Distributed, not conversational; archive-space, not conversation-space.                  |
| Announcement ("practice canceled tomorrow")  | `message`                    | Addressed and moment-indexed even though one-way; its meaning decays with its moment.    |
| Meeting minutes                              | `note`                       | The group's own working record; optionally _announced_ with a `message` linking to it.   |
| Group how-to ("opening the clubhouse")       | `note`                       | Living document, current state matters, collectively maintained.                         |
| Same how-to on the club's public website     | `page`                       | Same text, different act: now a node in a published site.                                |
| Recipe in your kitchen file                  | `note`                       | Kept.                                                                                    |
| Same recipe on your blog                     | `article`                    | Published. The type records the act, not the text.                                       |
| Sharing a link into the group ("read this!") | `message` (+ rel.)           | The commentary is speech; the shared bookmark/article stays an artifact, linked.         |
| Social media post                            | _deferred (#15)_             | A fourth contract — public broadcast — see below.                                        |

## Comments are messages; marginalia are notes

The blog-comment case is recorded here because it sharpened the whole framing. A
comment passes the speech test on every axis: addressed to the author and other
readers, a move in a conversation anchored to the post, moment-indexed, tamper-evident.
So a comment is a **`message` whose `parentId` is the article** — which is why
`message`'s threading convention lets _any_ record anchor a thread. The thing that
superficially resembles a comment but fails the test — a reader's private annotation —
is a `note` with an `about` relationship. Both exist; the test separates them.

## The fourth contract, deliberately not covered here

Public broadcast — speech addressed to whoever listens, rather than to a bounded
audience that a stack's membership defines — is a distinct contract (**posts are
broadcast**), and it is deliberately outside this guide. It is the territory of the
ATProto-compat RFC (#15): a broadcast utterance needs self-certified authorship (#49)
and cross-stack reference, neither of which bounded-audience `message` records require.
Neither `message` nor `article` should absorb it.

## Consequences for app authors

- **Consumers key UX on `typeId`.** A reading app renders articles with bylines and
  publication dates; a board app renders messages chronologically with authors and
  reply affordances; a notes app renders an editable current state. Mis-typing a record
  puts it in the wrong UX in _every other app_, which is why this guide exists.
- **All three share the `{ text }` read-compat core** — deliberately. Generic text
  consumers reach everything via `isCompatible()`; the `typeId` is the contract signal
  for consumers that need to honor it. Reach and semantics are separate mechanisms.
- **Contracts don't convert in place.** A note becoming an article (or a message being
  written up into a note) is a _new record_ linked with a `derived-from` relationship —
  never a retype of the existing record, whose history belongs to its original
  contract.
