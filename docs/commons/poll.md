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

Prior art: ActivityStreams `Question` (Mastodon polls), Doodle/when2meet, Loomio, and
the social-choice literature (plurality, approval, instant-runoff, Borda and score
voting) for the method vocabulary.

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
    scoreMax: { kind: 'number' },
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
          score: { kind: 'number' },
        },
      },
    },
  },
});
```

## Field semantics — `poll@1`

| Field      | Kind     | Required | Meaning                                                                                                                                                                                                 |
| ---------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `question` | `string` | yes      | What's being decided.                                                                                                                                                                                   |
| `options`  | `array`  | yes      | The choices. Each has a stable `id` (identity — never reused or repurposed), a `label`, and optionally `startsAt`/`endsAt` when the option is a time slot (the when-to-meet case).                      |
| `method`   | `string` | no       | How ballots are counted: `"plurality"` (default when absent, and the reading of an unknown value), `"approval"`, `"instant-runoff"`, `"borda"` or `"score"`. See [Counting methods](#counting-methods). |
| `scoreMax` | `number` | no       | The top of the range every ballot's scores are read on, a positive integer; the bottom is always 0. Absent, or not a positive integer, means 1: plain yes or no.                                        |
| `closesAt` | `date`   | no       | Voting deadline. Absent means open; closing a poll is setting it.                                                                                                                                       |
| `details`  | `text`   | no       | Context for the decision. Markdown by convention.                                                                                                                                                       |

## Field semantics — `vote@1`

| Field     | Kind         | Required | Meaning                                                                                                                                                                                                                                                                                                                                             |
| --------- | ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pollId`  | `record-ref` | yes      | The poll this ballot answers. A top-level scalar, so "all ballots for poll X" is one exact-match content query.                                                                                                                                                                                                                                     |
| `choices` | `array`      | yes      | The voter's answers. Each entry names an `optionId` and optionally a `score` from 0 (no) to the poll's `scoreMax` (yes). Absent means `scoreMax`: listing an option is a full yes. A score that is not an integer in range reads as 0. An option absent from `choices` is a no. Entry order breaks ties between equal scores, most-preferred first. |

## Counting methods

`method` names the rule that turns ballots into a result, and every method reads the
same ballot. An option is **on the ballot** when its score is above 0, and a ballot's
**ranking** is its options on the ballot by score, highest first, with entry order
breaking ties. Methods that rank read the ranking; methods that add read the scores.
An unknown method reads as `"plurality"`, the method that claims least of a ballot:
only its top-ranked option.

| `method`                            | How a result is counted                                                                                                                                                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"plurality"` (default when absent) | Each ballot's top-ranked option gets one vote. Most votes wins.                                                                                                                                                                                                                     |
| `"approval"`                        | Every option on a ballot gets one vote, whatever its score. Most votes wins.                                                                                                                                                                                                        |
| `"instant-runoff"`                  | In rounds. Each ballot counts for its highest-ranked option still standing. An option holding more than half of the ballots still counting wins; otherwise every option tied for fewest is eliminated and the next round counts again. A ballot with no option left stops counting. |
| `"borda"`                           | With _n_ options in the poll when it is counted, a ballot's top-ranked option gets _n_ − 1 points, its second _n_ − 2, and so on; options not on it get 0. Highest total wins.                                                                                                      |
| `"score"`                           | Every entry adds its score to its option. Options not on a ballot add 0. Highest total wins.                                                                                                                                                                                        |

Every method shares these rules:

- **An entry counts once, for an option the poll has.** An entry naming no option of the
  poll is ignored, and so is a repeat of an option already on the ballot.
- **A tie is a result.** No method breaks one. Under `"instant-runoff"`, a round in
  which every remaining option is tied for fewest ends in a tie among them.
- **Scores are stored, words are shown.** A UI labels the values between 0 and
  `scoreMax`; the conventional labels for `scoreMax: 2` are no, if need be, and yes.
  The number is what every reader agrees on, so no stored word can be misread.

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
  warn; the `closesAt` cutoff then applies to that ballot alone.
- **Results are computed, never stored.** Any member's app tallies by reading ballots;
  a stored result would go stale and would have an author.
- **Once a poll has ballots, it changes only by appending options or setting
  `closesAt`.** Every other field — the question, an option's label or slot, `method`,
  `scoreMax` — is what existing ballots were cast against, so changing one is the poll
  author starting over with a new poll. Appended options take new `id`s.
- **`closesAt` is applied by readers, to current state.** A ballot whose `updatedAt` is
  after `closesAt` does not count, and writers refuse edits once a poll closes. The
  stack cannot fence one poll's ballots against writes, since a grant covers a whole
  type, so the deadline is a reading rule. Its cost falls only on the voter: a late
  edit forfeits their own ballot and touches no one else's.
- **Ballot visibility is the grant system, and @1 is honest about it: polls are open
  ballot by default.** Members with read access to the group's records see who voted
  for what — right for when-to-meet and most small-group decisions. A semi-secret
  ballot already falls out of the primitives: grant members `create`/`read-own`/
  `update-own` (but not `read-any`) on `vote@1`, and only holders of `read-any` — the
  owner, and whoever is granted it — can tally and post results. True secret ballots
  (nobody, including the owner, learns individual votes) are cryptographic territory
  the commons does not pretend to cover.
- **When-to-meet, end to end**: poll with `method: "score"`, `scoreMax: 2` and time-slot
  options; members score each slot 2 (yes), 1 (if need be) or 0 (no); the organizer
  promotes the winning slot to an [`event`](./event.md) and links it to the poll with
  the [`decided-by`](./README.md#cross-type-conventions) cross-type label.

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
