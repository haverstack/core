# `org.haverstack/poll@1` + `org.haverstack/vote@1` — Poll & Vote

> **Status:** Draft. Intended writer: a group-decisions app (in progress by the project
> maintainer). Lives in the group cluster. Defined as a pair in one file because neither
> type means anything without the other.

Group decision-making: the one-off voting platform and the when-to-meet scheduler are
the same primitive — a question with options, answered per-member. A scheduling poll is
simply a poll whose options carry time slots; the winning slot gets promoted to a real
[`event`](./event.md).

The design leans on the stack's native machinery harder than any other commons type:
each member's ballot is a **record they author** (`createdBy` = voter, set natively),
revising a ballot is an ordinary update (version history = a free audit trail), and
who-may-vote is a grant on `vote@1` — the permission system is the election official.

**A poll is voice, not authority.** Polls and ballots are ordinary Records: nothing in
the stack reads a result, and no write anywhere is gated on one. What an outcome means —
advisory, binding by the group's own agreement, or a nudge to whoever holds the stack —
is each group's to decide, outside the data.

Prior art: ActivityStreams `Question` (Mastodon polls), Doodle/when2meet, Loomio,
Condorcet/approval balloting literature for the method vocabulary.

## Schema

```ts
await stack.defineType({
  id: 'org.haverstack/poll@1',
  name: 'Poll',
  schema: {
    question: { kind: 'string', required: true },
    options: {
      kind: 'array',
      required: true,
      items: {
        kind: 'object',
        properties: {
          id: { kind: 'string', required: true },
          label: { kind: 'string', required: true },
          startsAt: { kind: 'date' },
          endsAt: { kind: 'date' },
        },
      },
    },
    method: { kind: 'string' },
    closesAt: { kind: 'date' },
    details: { kind: 'text' },
  },
});

await stack.defineType({
  id: 'org.haverstack/vote@1',
  name: 'Vote',
  schema: {
    pollId: { kind: 'record-ref', required: true },
    choices: {
      kind: 'array',
      required: true,
      items: {
        kind: 'object',
        properties: {
          optionId: { kind: 'string', required: true },
          response: { kind: 'string' },
        },
      },
    },
  },
});
```

## Field semantics — `poll@1`

| Field      | Kind     | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `question` | `string` | yes      | What's being decided.                                                                                                                                                                                                                                                                                                                                                                          |
| `options`  | `array`  | yes      | The choices. Each has a stable `id` (identity — never reused or repurposed), a `label`, and optionally `startsAt`/`endsAt` when the option is a time slot (the when-to-meet case).                                                                                                                                                                                                             |
| `method`   | `string` | no       | How ballots are counted. Well-known values: `"single"` (default when absent — a ballot's first choice is its vote) and `"multiple"` (every choice counts). An open vocabulary (`"ranked"`, `"score"` are anticipated proposals); a reader treats an unknown method as `"single"`, which counts each ballot's first preference — a plurality reading of any ballot, since `choices` is ordered. |
| `closesAt` | `date`   | no       | Voting deadline. Absent means open; closing a poll is setting it.                                                                                                                                                                                                                                                                                                                              |
| `details`  | `text`   | no       | Context for the decision. Markdown by convention.                                                                                                                                                                                                                                                                                                                                              |

## Field semantics — `vote@1`

| Field     | Kind         | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | ------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pollId`  | `record-ref` | yes      | The poll this ballot answers. A top-level scalar, so "all ballots for poll X" is one exact-match content query.                                                                                                                                                                                                                                                                                                                  |
| `choices` | `array`      | yes      | The endorsed options, **most-preferred first** (ordering is significant now so ranked methods can arrive without a version bump). Each entry names an `optionId` and optionally a `response`: well-known values `"yes"` (default when absent, and the reading of an unknown value) and `"maybe"` (the when-to-meet "if need be"). An option absent from `choices` is a no, and an entry naming no option of the poll is ignored. |

## Conventions

- **Why `pollId` is content, not `parentId`.** A ballot's poll is a _constitutive_
  reference (see README rule 5): required — schema validation rejects a poll-less vote
  at write time, which `parentId` (native, unrequirable) never could — homogeneous
  (always a poll, unlike a `message`'s anchor, which is optional and can be any
  record), and immutable in spirit: re-parenting is legal, ordinary behavior elsewhere
  in the commons, but a re-targeted ballot is fraud-shaped, so the reference lives
  where repointing is a visible, versioned content edit. The trade: `parentId`
  filtering is native on every adapter, while `content: { pollId }` needs a
  `filter.content` reach — on adapters without one, tallying is a scan of `vote@1`
  records, which is fine at the scale of a small group.
- **One ballot per member per poll.** Revoting is updating your existing `vote` record,
  not creating a second — a writer obligation (query `pollId` + own
  `createdBy.subjectId` before creating), with version history preserving every
  revision. Duplicate ballots from a buggy writer: latest `updatedAt` wins, consumers
  warn.
- **Results are computed, never stored.** Any member's app tallies by reading ballots;
  a stored result would go stale and would have an author.
- **Option lists may grow while open** (append-only, new `id`s); changing or removing
  voted-on options is the poll author starting over with a new poll.
- **`closesAt` is a reading rule, applied the same way by every reader.** A ballot
  counts as it stood at the deadline: its latest version whose `updatedAt` is at or
  before `closesAt`, read from version history, and not at all if every version is
  later. A late revision is kept in history like any other, and simply not counted.
- **Ballot visibility is the grant system, and @1 is honest about it: polls are open
  ballot by default.** Members with read access to the group's records see who voted
  for what — right for when-to-meet and most small-group decisions. A semi-secret
  ballot already falls out of the primitives: grant members `create`/`read-own`/
  `update-own` (but not `read-any`) on `vote@1`, and only holders of `read-any` — the
  owner, and whoever is granted it — can tally and post results. True secret ballots
  (nobody, including the owner, learns individual votes) are cryptographic territory
  the commons does not pretend to cover.
- **When-to-meet, end to end**: poll with `method: "multiple"` and time-slot options;
  members respond with `"yes"`/`"maybe"` per slot; the organizer promotes the winning
  slot to an [`event`](./event.md) and links it to the poll with the
  [`decided-by`](./README.md#cross-type-conventions) cross-type label.

## Read-compat cores

```ts
// poll
{
  question: { kind: 'string', required: true },
  options: {
    kind: 'array',
    required: true,
    items: {
      kind: 'object',
      properties: {
        id: { kind: 'string', required: true },
        label: { kind: 'string', required: true },
      },
    },
  },
}
// vote
{
  pollId: { kind: 'record-ref', required: true },
  choices: {
    kind: 'array',
    required: true,
    items: { kind: 'object', properties: { optionId: { kind: 'string', required: true } } },
  },
}
```

Each core carries the required fields of its array's elements too: a tally reads
`options[].id` and `choices[].optionId`, so a compatible type must promise them.

## Deliberately excluded

- Stored results/tallies — computed, see conventions.
- Anonymous ballots — `ScopedStack.create()` always stamps the requester as `createdBy`,
  and pretending otherwise would be a lie; see ballot visibility above.
- Quorum/threshold rules — the deciding app's policy (sidecar on the poll), not ballot
  data.
- Delegation/proxy voting (liquid democracy) — real prior art (Loomio, LiquidFeedback)
  but a method + trust model, not a field; future proposal.
