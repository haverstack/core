# CLI design sketch

> Design sketch, not a spec. Nothing here is implemented or committed to. It sits
> alongside [`spec.md`](./spec.md) rather than under `spec/` because it describes a
> tool built on the model, not the model itself.

## Goal

An admin CLI (`stack`) for operating directly on a Stack: list/inspect Records,
register Types, create/edit Records via `$EDITOR`, and manage associations and
permissions — without needing a server or a browser.

## Non-goals (v1)

- A picker UI for choosing among live records/entities/groups when wiring up an
  association or grant (flags take raw IDs; see [Open question](#open-question-picking-targets)).
- Authoring migration functions (`registerMigration`) — those are app code, not
  admin data; out of scope for a CLI that manipulates Records and Types, not app logic.
- Remote/server-backed stacks. v1 targets a local adapter (`adapter-local`) opened
  directly, full trust, same posture as an unscoped `Stack`. A `--stack <url>`
  wire-client mode is a plausible v2, not a v1 requirement.

## Porcelain split

Following git's plumbing/porcelain split: `$EDITOR` + front matter is for
`content` and scalar native fields, where free text is a fine interface.
Everything relational — associations, permissions, grants — goes through
dedicated subcommands instead. A picker is nice-to-have for those; flags alone
are not a blocker to shipping v1.

Rationale (recap from discussion): typing a raw Crockford-32 record ID or a DID
into a text file is exactly the kind of thing a text editor is bad at, and a
command with tab-completion and validation is better even before any picker exists.

## Command surface

```
stack types list                              # list registered Types (id, name, schemaHash)
stack types show <typeId>                     # print schema as JSON
stack types register <schema.json>            # defineType() from a file
                                               #   { id, name, schema, migratesFrom? }

stack ls [--type <typeId>] [--base <baseId>] [--parent <id>|--root]
         [--tag <label>]... [--limit N] [--cursor <c>] [--json]
stack show <id> [--json] [--history]          # get() (optionally getVersions())

stack new <typeId> [--parent <id>] [--id <id>]  # opens $EDITOR on a scaffolded file
stack edit <id>                                 # opens $EDITOR on the current record
stack rm <id> [--hard]                          # delete() / undelete() companion: stack restore <id>

stack tag <id> add <label>
stack tag <id> rm <label>

stack link <id> add --label <label> \
    (--to-record <recordId> [--stack-url <url>] | --to-entity <did> | --to-external <ns> <id>)
stack link <id> rm --label <label> <same target flags>

stack attach <id> add --label <label> --file <path>
stack attach <id> rm --label <label> --file-id <sha256>

stack perm <id> add (--public | --entity <did> | --group <id> [--role admin]) [--read] [--write]
stack perm <id> rm  (--public | --entity <did> | --group <id>)

stack grant <typeId> add (--entity <did> | --group <id> | --default) <action>...
stack grant <typeId> rm  (--entity <did> | --group <id> | --default) <action>...
stack grant ls [--type <typeId>]
```

Every list/show command supports `--json` for piping into `jq` — the CLI is a
script-composable client, not just an interactive one.

## Editing via `$EDITOR`

`stack new`/`stack edit` write a scratch file, open `$EDITOR` on it, and on save
diff it back into a `create()`/`update()` call.

```
---
id: 01hx3k9m2p7q          # readonly; blank on `new`
type: com.example/task@2
parent: ~
tags: [work, urgent]
# associations and permissions aren't edited here.
# use `stack link`, `stack tag`, `stack perm`, `stack grant` instead.
_readonly:
  version: 4
  createdAt: 2026-08-01T10:00:00Z
  updatedAt: 2026-09-01T09:00:00Z
  entityId: did:key:z6Mk...
  associations:
    - { kind: tag, label: work }
    - { kind: relationship, label: parent-project, target: { scope: record, recordId: 01h... } }
  permissions:
    - { access: entity, entityId: did:key:z6Mk..., read: true, write: false }
title: Ship the CLI sketch
dueDate: 2026-09-10
done: false
---
Notes on the task go here — this maps to the schema's `text` field (`body`,
by convention, or whichever field the Type declares first).
```

- **Front matter = scalar `content` fields + `parent`/`tags`.** Everything a
  `TypeSchema` declares as `string`/`number`/`boolean`/`date`/`record-ref`/`file-ref`
  round-trips as a YAML scalar. `array`/`object` fields round-trip as nested YAML.
- **Body = the one designated `text` field**, if the Type has one (convention:
  a field literally named `body`, or the first declared `text` field). Types with
  no `text` field get an empty/unused body.
- **`_readonly` is exactly that** — associations, permissions, `version`, and
  authorship fields are shown so the file is a faithful snapshot of the record,
  but the CLI diffs the file ignoring that block and errors if it was edited,
  pointing at the porcelain command that actually changes it.
- **Optimistic concurrency**: the hidden `version` backs `ifVersion` on `update()`,
  so a stale edit (someone else wrote the record while `$EDITOR` was open) is a
  conflict, not a silent overwrite — same guarantee [Versioning & deletion](./spec/versioning.md)
  gives every other writer.
- **Validation loop**: on save, validate content against the Type's schema before
  calling `create()`/`update()`. On failure, reopen `$EDITOR` on the same buffer
  with the error prepended as a comment, rather than discarding the edit.

## Type registration

`stack types register <schema.json>` takes a file shaped like `defineType()`'s
arguments:

```json
{
  "id": "com.example.myapp/task@2",
  "name": "Task",
  "schema": { "title": { "kind": "string", "required": true }, "dueDate": { "kind": "date" } },
  "migratesFrom": "com.example.myapp/task@1"
}
```

and calls `stack.defineType()`, surfacing `StackSchemaDriftError` as-is (a version
bump, not a flag, is the fix — see [Schema drift detection](./spec/data-model.md#schema-drift-detection)).
Registering a *migration function* stays out of scope — that's a JS closure over
old/new content, not admin data a CLI flag can carry.

## Open question: picking targets

`--to-record`, `--to-entity`, `--group`, `--entity` all currently take a raw ID
typed by hand. Two ways to soften that without building a full TUI:

1. **Shell out to `stack ls`/`stack query` + `jq`/`fzf`** and let the user compose
   the ID themselves — zero CLI-side work, matches how git/kubectl users already
   chain commands.
2. **A `--pick` flag** that, given a type or a partial filter, launches a short
   interactive fuzzy-picker (e.g. an [Ink](https://github.com/vadimdemedes/ink)
   screen backed by `stack.query()`) and substitutes the resolved ID into the
   command that invoked it — additive, doesn't change the flag-based path, and
   is the natural place to grow toward the fuller TUI discussed earlier if flags
   alone prove too clunky in practice.

Neither blocks v1; `--pick` is worth revisiting once the porcelain commands exist
and it's clear which ones actually get used with unfamiliar IDs often enough to
justify it.

## Package shape

- New package: `packages/cli` (name TBD, e.g. `@haverstack/cli`, bin `stack`).
- Depends on `@haverstack/core` + `@haverstack/adapter-local` directly — no wire
  client in v1, so no dependency on `adapter-api`.
- `--stack <path>` (default: a config file or `$STACK_PATH`) selects which local
  database to operate on; no notion of "current stack" beyond that.
- Argument parsing: none of `commander`/`clipanion`/`citty` are in the repo today;
  picking one is a small, low-stakes decision to make when implementation starts
  rather than something to settle in this sketch.
