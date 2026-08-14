# @haverstack/commons

Canonical [Schema Commons](https://github.com/haverstack/core/tree/main/docs/commons)
type definitions for Haverstack.

The commons namespace `org.haverstack` is reserved for a small set of well-known,
neutrally-governed types (`note`, `bookmark`, `task`, ...) so that apps sharing a stack
can interoperate on the data shapes almost every personal app touches. That only works
if every app registers a commons type **exactly as written** — a modified copy under
the same `typeId` is schema drift, and the drift guard will (correctly) reject it. This
package makes that structural rather than social: import the constant, don't
hand-transcribe a schema out of markdown.

> **Status:** Early development. Exports only Draft-status types — see
> [`docs/commons/README.md`](https://github.com/haverstack/core/blob/main/docs/commons/README.md)
> for what Draft/Staged/Proposed mean. Proposed types have no intended writer yet and
> stay docs-only until they graduate.

## Installation

```sh
npm install @haverstack/commons
```

## Usage

```ts
import { Stack } from '@haverstack/core';
import { defineCommonsTypes, NOTE, TASK } from '@haverstack/commons';

// Register only the commons types your app actually writes.
await defineCommonsTypes(stack, [NOTE, TASK]);

const note = await stack.create(NOTE.id, { text: 'Hello, Haverstack!' });
```

Each export (`NOTE`, `BOOKMARK`, `TASK`, `CONTACT`, `ARTICLE`, `PLACE`, `PAGE`, `PHOTO`)
is a `{ id, name, schema }` triple mirroring its type's `stack.defineType(...)` block in
[`docs/commons/`](https://github.com/haverstack/core/tree/main/docs/commons) exactly.
`defineCommonsTypes()` is a thin loop over `stack.defineType()` — calling it again with
types already registered is the ordinary idempotent no-op path (see `defineType`'s own
docs), so it's safe to call on every app startup.

## Governance

The schemas here are not this package's to change. A type's shape, required core, and
conventions are decided by the process in
[`docs/commons/README.md` § Governance](https://github.com/haverstack/core/blob/main/docs/commons/README.md#governance) —
propose additions or changes there, as an issue on `haverstack/core` titled
`Commons: <proposal>`. This package's constants are updated to match once a proposal
lands; it never carries a schema the docs don't also carry.

## License

[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) — public domain.

## Monorepo

Part of [haverstack/core](https://github.com/haverstack/core).
