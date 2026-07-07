# `org.haverstack/event@1` — Event

> **Status:** Proposed — awaiting an intended writer (a group-calendar app). Lives in
> the group cluster; equally meaningful in personal stacks.

Something at a time: a meeting, a gathering, a deadline with a duration. The shared
group calendar is the motivating consumer — the thing today delegated to a shared
Google calendar.

Prior art: iCalendar `VEVENT` (SUMMARY, DTSTART, DTEND, DESCRIPTION, URL),
schema.org/Event. The design takes VEVENT's universally-used core and explicitly
excludes its famously hard part (recurrence — see conventions).

## Schema

```ts
await stack.defineType('org.haverstack/event@1', 'Event', {
  title: { kind: 'string', required: true },
  startsAt: { kind: 'date', required: true },
  endsAt: { kind: 'date' },
  allDay: { kind: 'boolean' },
  description: { kind: 'text' },
  url: { kind: 'string' },
});
```

## Field semantics

| Field         | Kind      | Required | Meaning                                                                                                                                                                       |
| ------------- | --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | `string`  | yes      | What it is ("Monthly meeting", "Spring cleanup day").                                                                                                                         |
| `startsAt`    | `date`    | yes      | When it begins — an absolute instant (ISO 8601, per #69). An event is meaningless without a time.                                                                             |
| `endsAt`      | `date`    | no       | When it ends. Absent means unspecified duration (a deadline, a "starts at 7pm" with no stated end).                                                                           |
| `allDay`      | `boolean` | no       | Absent means `false`. When `true`, times-of-day are ignored: the event occupies the calendar date(s) of `startsAt`(–`endsAt`) interpreted in the stack's configured timezone. |
| `description` | `text`    | no       | Details. Markdown by convention.                                                                                                                                              |
| `url`         | `string`  | no       | Where it happens online (video-call link) or a canonical event page.                                                                                                          |

## Conventions

- **Physical location** is the cross-type `location` relationship to a
  [`place`](./place.md) record — which is what makes "map of everywhere our group
  meets" a query, not a feature.
- **Recurrence is excluded from @1, and the @1 answer is materialization.** Writers
  create the actual occurrence records ("every 2nd Tuesday" → the next N Tuesdays),
  which keeps every consumer trivially correct — a calendar app that has never heard of
  recurrence still renders the schedule. The generating rule (RRULE-shaped) lives in
  the writing app's sidecar on its own anchor record; occurrences link to that anchor
  with `{ kind: 'relationship', label: 'series', recordId }` (a reserved cross-type
  label) so any app can group them. A commons recurrence proposal (RRULE prior art) is
  expected eventually; it must land as an additive companion, not a reinterpretation of
  occurrence records.
- **Querying a date range**: content filters are exact-match only, so "events in May"
  is not a content query. At group scale, consumers fetch events (or filter by
  `createdAt` coarsely) and range-filter app-side — same honest trade as `article`
  drafts and `place` proximity.
- **RSVPs / attendance** are per-member responses — the same shape as
  [`poll`](./poll.md) votes, and a future proposal should generalize from `vote` rather
  than inventing a parallel mechanism. Until then, attendance is app territory.
- **Cancellation** is soft-deletion (recoverable, history preserved), not a status
  field.

## Read-compat core

```ts
{
  title:    { kind: 'string', required: true },
  startsAt: { kind: 'date', required: true },
}
```

Anything titled-and-timed — a task app's scheduled block, a trip leg, a poll's winning
time slot promoted to a real event — can appear on a calendar consumer's calendar.

## Deliberately excluded

- Recurrence rules — see conventions; materialize occurrences.
- Attendees/RSVP fields — per-member records, future proposal generalizing `vote`.
- Reminders/alarms — perspectives (each member wants their own); app-side.
- Free-text `location` string — use the `location` relationship for real places and
  `url`/`description` for virtual ones; a freeform field would become the junk drawer
  that keeps both honest mechanisms unused.
- Timezone-per-event — @1 events are absolute instants plus the stack-timezone rule
  for `allDay`; floating times and cross-timezone display are app concerns until a real
  writer demonstrates the need.

## Changelog

- **Proposed** — initial definition: `title`, `startsAt` (required), `endsAt`,
  `allDay`, `description`, `url`.
