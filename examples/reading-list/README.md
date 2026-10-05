# Reading list example

A small book tracker built on `@haverstack/core`. It covers most of the app-facing API, so you can judge how it reads in practice.

| File                                                             | What it shows                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `src/schema.ts`                                                  | Type handles, including a `@1 → @2` schema evolution and an `enum`                                                                                                                                                                                                      |
| `src/reading-list.ts`                                            | The app layer: shelves as parent records, tags, ISBN as an external relationship, reviews as record relationships, covers as attachments, cursor pagination, `ifVersion` concurrency, history/revert, soft delete, change subscriptions, type- and record-level sharing |
| `src/main.ts`                                                    | Narrated walkthrough on a real on-disk `LocalAdapter` stack                                                                                                                                                                                                             |
| `tests/reading-list.test.ts`                                     | The same behaviors, run against both `MemoryAdapter` and `LocalAdapter`                                                                                                                                                                                                 |
| [`FINDINGS.md`](./FINDINGS.md)                                   | Round one: what building it revealed about the API's ergonomics                                                                                                                                                                                                         |
| [`CONCLUSIONS.md`](./CONCLUSIONS.md), [`ISSUES.md`](./ISSUES.md) | The decisions taken on each round-one finding, and the issue plan                                                                                                                                                                                                       |
| [`FINDINGS-2.md`](./FINDINGS-2.md)                               | Round two: the app rebuilt on the fixed core, a scorecard against round one, and new findings                                                                                                                                                                           |     |

```sh
pnpm run build             # at the repo root, once
cd examples/reading-list
pnpm start                 # the walkthrough
pnpm test
```

This package is private and is never published.
