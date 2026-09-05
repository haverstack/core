# `org.haverstack/poll@1` + `org.haverstack/vote@1` — Poll & Vote

> **Status:** Proposed — awaiting an intended writer (a group-decisions app). Lives in
> the group cluster. Defined as a pair in one file because neither type means anything
> without the other.

Group decision-making: the one-off voting platform and the when-to-meet scheduler are
the same primitive — a question with options, answered per-member. A scheduling poll is
simply a poll whose options carry time slots; the winning slot gets promoted to a real
[`event`](./event.md).

The design leans on the stack's native machinery harder than any other commons type:
each member's ballot is a **record they author** (`entityId` = voter, set natively),
revising a ballot is an ordinary update (version history = a free audit trail), and
who-may-vote is a grant on `vote@1` — the permission system is the election official.

Prior art: ActivityStreams `Question` (Mastodon polls), Doodle/when2meet, Loomio,
Condorcet/approval balloting literature for the method vocabulary.

## Schema

```ts
await stack.defineType('org.haverstack/poll@1', 'Poll', {
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
});

await stack.defineType('org.haverstack/vote@1', 'Vote', {
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
});
```

## Field semantics — `poll@1`

| Field      | Kind     | Required | Meaning                                                                                                                                                                                                                                                                                                            |
| ---------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `question` | `string` | yes      | What's being decided.                                                                                                                                                                                                                                                                                              |
| `options`  | `array`  | yes      | The choices. Each has a stable `id` (identity — never reused or repurposed), a `label`, and optionally `startsAt`/`endsAt` when the option is a time slot (the when-to-meet case).                                                                                                                                 |
| `method`   | `string` | no       | How ballots are counted. Well-known values: `"single"` (default when absent — pick one) and `"multiple"` (pick any). An open vocabulary by design (`"ranked"`, `"score"` are anticipated proposals). Consumers seeing an unknown method must display raw ballots and refuse to compute a result rather than guess. |
| `closesAt` | `date`   | no       | Voting deadline. Absent means open until the poll is soft-deleted or superseded.                                                                                                                                                                                                                                   |
| `details`  | `text`   | no       | Context for the decision. Markdown by convention.                                                                                                                                                                                                                                                                  |

## Field semantics — `vote@1`

| Field     | Kind         | Required | Meaning                                                                                                                                                                                                                                                                                                                               |
| --------- | ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pollId`  | `record-ref` | yes      | The poll this ballot answers. A top-level scalar, so "all ballots for poll X" is one exact-match content query.                                                                                                                                                                                                                       |
| `choices` | `array`      | yes      | The endorsed options, **most-preferred first** (ordering is significant now so ranked methods can arrive without a version bump). Each entry names an `optionId` and optionally a `response`: well-known values `"yes"` (default when absent) and `"maybe"` (the when-to-meet "if need be"). An option absent from `choices` is a no. |

## Conventions

- **Why `pollId` is content, not `parentId`.** A ballot's poll is a _constitutive_
  reference (see README rule 5): required — schema validation rejects a poll-less vote
  at write time, which `parentId` (native, unrequirable) never could — homogeneous
  (always a poll, unlike a `message`'s anchor, which is optional and can be any
  record), and immutable in spirit: re-parenting is legal, ordinary behavior elsewhere
  in the commons, but a re-targeted ballot is fraud-shaped, so the reference lives
  where repointing is a visible, versioned content edit. The honest trade: `parentId`
  filtering is natively indexed on every adapter, while `content: { pollId }` needs
  a `filter.content` reach — on adapters without one, tallying degrades to
  fetch-and-scan of `vote@1` records, which is fine at this project's stated scale
  (small cohesive groups) and recorded here so nobody discovers it by surprise.
- **One ballot per member per poll.** Revoting is updating your existing `vote` record,
  not creating a second — a writer obligation (query `pollId` + own `entityId` before
  creating), with version history preserving every revision. Duplicate ballots from a
  buggy writer: latest `updatedAt` wins, consumers warn.
- **Results are computed, never stored.** Any member's app tallies by reading ballots;
  a stored result would go stale and would have an author.
- **Option lists may grow while open** (append-only, new `id`s); changing or removing
  voted-on options is the poll author starting over with a new poll. `closesAt`
  enforcement is a writer obligation — consumers must ignore ballots whose `updatedAt`
  postdates it.
- **Ballot visibility is the grant system, and @1 is honest about it: polls are open
  ballot by default.** Members with read access to the group's records see who voted
  for what — right for when-to-meet and most small-group decisions. A semi-secret
  ballot already falls out of the primitives: grant members `create`/`read-own`/
  `update-own` (but not `read-any`) on `vote@1`, and only the group owner can tally and
  post results. True secret ballots (nobody, including the owner, learns individual
  votes) are cryptographic territory the commons does not pretend to cover.
- **When-to-meet, end to end**: poll with `method: "multiple"` and time-slot options;
  members respond with `"yes"`/`"maybe"` per slot; the organizer promotes the winning
  slot to an `event@1` and links it
  `{ kind: 'relationship', label: 'decided-by', recordId: <poll> }`.

## Read-compat cores

```ts
// poll
{ question: { kind: 'string', required: true }, options: { kind: 'array', required: true } }
// vote
{ pollId: { kind: 'record-ref', required: true }, choices: { kind: 'array', required: true } }
```

## Deliberately excluded

- Stored results/tallies — computed, see conventions.
- Anonymous ballots — `ScopedStack.create()` always stamps the requester's `entityId`,
  and pretending otherwise would be a lie; see ballot visibility above.
- Quorum/threshold rules — the deciding app's policy (sidecar on the poll), not ballot
  data.
- Delegation/proxy voting (liquid democracy) — real prior art (Loomio, LiquidFeedback)
  but a method + trust model, not a field; future proposal.

## Changelog

- **Proposed** — initial definition: `poll@1` (`question`, `options` required;
  `method`, `closesAt`, `details`), `vote@1` (`pollId`, `choices` required).
