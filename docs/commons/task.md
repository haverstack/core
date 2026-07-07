# `org.haverstack/task@1` — Task

> **Status:** Draft.

A to-do item: something with a description and a done-ness. Prior art (todo.txt,
iCalendar VTODO, every task app's export format) agrees on remarkably little beyond
that pair — so that pair is the required core, and the rest is optional.

## Schema

```ts
await stack.defineType('org.haverstack/task@1', 'Task', {
  title: { kind: 'string', required: true },
  done: { kind: 'boolean', required: true },
  notes: { kind: 'text' },
  due: { kind: 'date' },
  completedAt: { kind: 'date' },
});
```

## Field semantics

| Field         | Kind      | Required | Meaning                                                                                                                                                                                                      |
| ------------- | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`       | `string`  | yes      | What needs doing. Single line by convention.                                                                                                                                                                 |
| `done`        | `boolean` | yes      | Whether it's complete. Required (not optional-absent-means-open) so that it is a top-level scalar every adapter can filter on: `content: { done: false }` is _the_ query of every task app.                  |
| `notes`       | `text`    | no       | Longer description. Markdown by convention.                                                                                                                                                                  |
| `due`         | `date`    | no       | When it's due. A deadline, not a calendar block — tasks with rich scheduling belong to a future `event` proposal.                                                                                            |
| `completedAt` | `date`    | no       | When it was completed. Writers should set it when setting `done: true` and clear it (write `null`, per the #69 merge-patch semantics) when un-completing. If `done` and `completedAt` disagree, `done` wins. |

## Conventions

- **Lists and subtasks**: `parentId`. A task whose parent is another task is a subtask;
  a task whose parent is a non-task record (an app's list/project record) is grouped
  under it. Commons deliberately does not define a `list` type in @1 — apps' project
  containers differ too much; what interops is the tasks themselves.
- **Ordering** within a list is a perspective (every app sorts differently) — app
  sidecar, not content.
- **Priority** is deliberately not in @1: prior-art vocabularies conflict (P1–P4,
  high/medium/low, 0–9) and most shared tasks don't carry one. Expected as a follow-up
  proposal with a single well-known string vocabulary, landing additively.
- **Blocking relationships**: `{ kind: 'relationship', label: 'blocked-by', recordId }`.

## Read-compat core

```ts
{
  title: { kind: 'string', required: true },
  done:  { kind: 'boolean', required: true },
}
```

## Deliberately excluded

- `status` string vocabularies (`open`/`in-progress`/`blocked`/…) — richer workflow
  states vary per app; `done` is the interoperable bit. An app with a status field keeps
  it in a sidecar and projects it to `done`.
- Recurrence — recurrence rules are the hardest part of iCalendar for a reason; they go
  with the future `event` proposal, not here.
- `assignee` — `entityId` is the author; assignment semantics inside a shared stack
  should be designed alongside the group/grant reshape (#57/#58), not guessed at now.

## Changelog

- **Draft** — initial definition: `title`, `done` (required), `notes`, `due`,
  `completedAt`.
