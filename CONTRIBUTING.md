# Contributing to Haverstack

Thanks for working on this. This document covers how to get set up, what to run before you push, and the conventions the codebase already follows — the ones that aren't obvious from reading a single file.

---

## Setup

The repo is a [pnpm workspace](https://pnpm.io/workspaces). CI runs Node 22 and pnpm 10; match those locally.

```sh
pnpm install
```

---

## Before you push

Run all five, in this order:

```sh
pnpm run format:check   # or: pnpm run format, to fix in place
pnpm run lint
pnpm test
pnpm run build
pnpm run typecheck      # must come after build — see below
```

These mirror `.github/workflows/ci.yml` exactly, so a clean local run means a green PR.

**`pnpm run typecheck` requires `pnpm run build` first.** Packages import each other through their published entry points (`@haverstack/core`, `@haverstack/sqlite-shared`, …), which resolve to `dist/*.d.ts`. Without a build, those imports fail with `TS2307: Cannot find module '@haverstack/core'`, and every type that came through them degrades to `unknown` — producing a cascade of unrelated-looking errors (`TS18046: 'err' is of type 'unknown'`) in code that is perfectly fine. CI encodes this: its `typecheck` job declares `needs: build`. If you see a wall of `unknown` errors, check whether the _first_ error in the list is a missing module, and build before doing anything else.

**`pnpm test` does not need a build.** Each package's `vitest.config.ts` aliases `@haverstack/*` specifiers to the other package's `src/` files, so tests always run against current source rather than a stale `dist`. A new cross-package dependency needs a matching alias added to the dependent package's vitest config, or its tests will resolve to `dist` and behave inconsistently. Subpath specifiers (`@haverstack/core/testing`, `@haverstack/core/did`, `@haverstack/core/wire`, `@haverstack/core/adapter`) each need their own alias entry pointing at the matching entry-point file, listed before the bare `@haverstack/core` entry so the more specific match wins.

---

## Commits and pull requests

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/): `docs:`, `fix:`, `feat:`, optionally scoped — `fix(conformance-fixtures): …`. Write the subject in the imperative, and use the body to explain _why_ the change was made, not what the diff already shows.

Issue references (`#123`) belong in commit messages, PR titles, and PR bodies. They do **not** belong in code comments — see [Comments](#comments) below.

Work on a branch and open a PR; CI must be green before merge. The PR template asks whether the change needs a spec update — answer it, including when the answer is "no behavior change."

If you're an AI coding agent, [AGENTS.md](./AGENTS.md) is the condensed, checkable form of this document.

---

## Releasing

Versions and npm publishes are automated with [Changesets](https://github.com/changesets/changesets). Nobody edits a `version` field by hand, and nobody runs `npm publish`.

### Adding a changeset

```sh
pnpm changeset
```

Commit the file it writes under `.changeset/` alongside the change it describes. **Name only the packages you actually changed** — dependents follow automatically, per [the ripple rule](#the-ripple-rule). A PR with no user-visible effect needs no changeset.

[changeset-bot](https://github.com/apps/changeset-bot) comments on every PR saying whether a changeset is present. It is a reminder, not a gate: plenty of PRs correctly have none. It is installed on the repository and configured by nothing here.

### Without a checkout

**Actions → Add changeset → Run workflow.** Pick your PR's branch in the **Use workflow from** selector and the changeset commits straight to it; run it from `main` and it opens its own PR. changeset-bot's comment carries a link to the same thing in the web editor — the difference is only who writes the frontmatter.

Run it before your last push. A commit pushed by `GITHUB_TOKEN` triggers no workflows, so a changeset landing as the newest commit leaves required checks with nothing to run against. Closing and reopening the PR re-triggers them.

### Choosing a bump

Every package is on `0.x`, where semver puts breaking changes in the **minor** slot:

| Change                                                              | Bump           |
| ------------------------------------------------------------------- | -------------- |
| Bug fix, docs, internals — nothing a consumer can observe           | `patch`        |
| Renamed or removed exports, changed behavior, a new required option | `minor`        |
| Nothing ships — tests, CI, repo tooling                             | _no changeset_ |

**Don't select `major`.** It cuts a 1.0 release, which is a decision about the install base (see [No backward compatibility yet](#no-backward-compatibility-yet)), not something a single PR makes.

`@haverstack/sqlite-shared` is `private` and has no version to publish. Record a change to it against `@haverstack/record-adapter-sqlite`, which bundles it. Naming a private package beside a public one makes Changesets refuse the whole release plan, so `scripts/expand-changesets.mjs` drops the line first — changeset-bot's template is safe to commit unedited. A changeset naming _only_ private packages fails: it would release nowhere.

### The ripple rule

Packages depend on each other through `workspace:^`, and on `0.x` a caret accepts patches but not minors:

- **A `patch` moves nothing else.** `^0.11.1` already accepts `0.11.2`.
- **A `minor` moves every dependent by a `minor`.** `^0.11.1` rejects `0.12.0`, so each dependent is republished against it — and carries the break through to its own consumers.

`scripts/expand-changesets.mjs` applies the second rule during `pnpm run version:packages`, transitively and for every workspace dependency: a `minor` to `@haverstack/wire-types` minor-bumps `@haverstack/adapter-api` and `@haverstack/conformance-fixtures`. It reads "breaking" off each package's own version, so the rule still holds past 1.0. Preview with:

```sh
node scripts/expand-changesets.mjs --dry-run
```

### What CI does

`.github/workflows/release.yml` runs on every push to `main`:

- **Changesets pending** → opens and updates a `chore: version packages` PR applying them: versions bumped, `CHANGELOG.md` entries written, changeset files deleted.
- **None pending** → builds, runs `pnpm run verify:pack`, publishes with `changeset publish`, and tags each release.

A release is one reviewable PR, and merging it is the act of publishing. Whoever can merge to `main` can publish, which is why `main` is protected.

### How the publish authenticates

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): a short-lived OIDC token, no `NPM_TOKEN` secret anywhere. Each published package carries a trusted publisher on npmjs.com:

| Field             | Value           |
| ----------------- | --------------- |
| Publisher         | GitHub Actions  |
| Organization/user | `haverstack`    |
| Repository        | `core`          |
| Workflow filename | `release.yml`   |
| Environment       | _(leave empty)_ |

Three things in `release.yml` are load-bearing:

- **`id-token: write`** — no OIDC token is minted without it.
- **No `registry-url` on `actions/setup-node`** — it writes an `.npmrc` referencing `${NODE_AUTH_TOKEN}`, which trusted publishing never sets, leaving pnpm to publish with unresolvable credentials. npm answers that with `E404` on the `PUT` rather than `401`, since it will not confirm a package exists to an unauthenticated caller. A 404 publishing a package that exists is an auth failure; `ENEEDAUTH` is no credential at all.
- **pnpm pinned to 11**, ahead of the 10 `ci.yml` pins — `changeset publish` shells out to `pnpm publish`, and the OIDC exchange is an 11.x feature. On 10 the publish fails with `ENEEDAUTH`.

Renaming the workflow file breaks every trusted publisher at once; each matches on the filename.

Under **Settings → Actions → General**, _Allow GitHub Actions to create and approve pull requests_ must stay on, or the version PR is never opened.

**A ninth package** needs one manual publish (trusted publishing configures only on a package that exists), then its own trusted publisher and an entry in the `package` dropdown in `.github/workflows/changeset.yml`.

**To gate the publish on a human:** create a GitHub environment with required reviewers, add `environment:` to the release job, and name it in every trusted publisher. All three must agree.

### Releasing by hand

```sh
pnpm run version:packages   # expand, apply changesets, format
pnpm run release            # build, verify:pack, changeset publish
```

`version:packages` needs a `GITHUB_TOKEN` in the environment — the changelog generator links each entry to its PR.

---

## Comments

The convention this codebase follows, in order of how often it comes up:

**Comments answer _why_. The _how_ should be visible in the code itself.** If a comment is narrating what the next few lines do, delete it and let the code speak. If the code is hard enough to follow that it needs narration, that's usually a signal to simplify the code.

**Keep them short — four or five lines is the extreme case, not the target.** Anything needing more explanation than that links out to the spec instead of carrying the argument inline:

```ts
/**
 * `_group` records are managed, not merely written: only the owner or an
 * `admin` roster holder may mutate them — ordinary write permissions and
 * grants don't apply. See docs/spec/identity.md § Group.
 */
```

**File-top module comments are exempt.** A comment at the top of a file may be as long as it needs to be to explain what the module does and why it exists.

**No GitHub issue references.** An issue captured something that needed to change, and the change is now reflected in the spec and the code. A `(#106)` in a comment adds nothing a reader can act on, and it makes the source unreadable anywhere the issue tracker isn't at hand. If the rationale matters, state it or link to the spec section that holds it.

**No references to previous implementations.** Comments describe the code as it is now. Phrases like "the old two-call design", "this used to take a single page", or "before this fix" date the comment and describe code that no longer exists. State the invariant instead:

```ts
// Don't:
// The old two-call design could crash between saveVersion() and the
// mutation, leaving an orphan row that collided with every future snapshot.

// Do:
// A versions row at the record's own current version is an orphan: no
// legitimate snapshot carries that number, since a snapshot commits
// atomically with the bump past it.
```

The same applies to tests. A regression test's comment should say what invariant it pins, not what bug prompted it.

**If a rule needs more than a few lines to justify, it belongs in the spec.** Add the section, then link to it. Comments that duplicate spec prose drift out of sync with it.

---

## The spec is the source of truth

Design decisions live in [`docs/spec.md`](./docs/spec.md) and its sub-documents under [`docs/spec/`](./docs/spec/). Code comments link _to_ the spec; they don't restate it.

A change to observable behavior — an API contract, a permission rule, a wire shape, an error mapping — updates the spec in the same PR. If you find yourself writing a long comment to explain a rule that isn't in the spec, that's the signal the spec is missing a section.

When you link to a spec section from a comment, use the `docs/spec/<file>.md § Section` form and make sure the section actually exists. Section names are load-bearing; renaming a heading means updating the references to it.

---

## No backward compatibility yet

**There is no install base.** Nothing depends on this library's current behavior, so there is nothing to preserve. Prefer changing things in place over carrying compatibility shims:

- No accepting an older data format "just in case" — no such data exists.
- No deprecation cycles; delete the old thing.
- No `legacy` branches in decoders, and no `legacy` in prose. A third-party implementation of the wire protocol is _foreign_, not legacy — that distinction is real and worth keeping.

The same policy is written down for the Schema Commons ([`docs/commons/README.md`](./docs/commons/README.md)), which changes definitions in place without version bumps for exactly this reason. When an install base appears, this section is the first thing that should change.

Note that this is about _our_ history, not about inputs we genuinely receive. Handling a foreign server's response shape, or a stack file written by another adapter, is current-behavior compatibility and stays.

---

## Architecture conventions

**`Stack` is the invariant layer; adapters are storage engines.** Validation, `_config` protection, ID rules, migration policy, and permission logic live in `packages/core` so every adapter inherits them. An adapter that reimplements an invariant is a bug waiting to diverge. The deliberate exception is documented in the spec: the `_config` query exclusion must live in each adapter's own query predicate, because post-filtering in `Stack` would under-fill a page.

**Package naming declares the adapter contract**, per [`docs/spec/adapters.md`](./docs/spec/adapters.md):

| Prefix             | Implements           |
| ------------------ | -------------------- |
| `adapter-*`        | full `StackAdapter`  |
| `record-adapter-*` | `StackRecordAdapter` |
| `blob-adapter-*`   | `StackBlobAdapter`   |

**Optional adapter capabilities follow one pattern**: an optional interface method, checked for truthiness at the call site, with a described fallback when absent — never a boolean flag in `capabilities`. `combineAdapters()` forwards an optional method only when the underlying part actually implements it.

**Logic shared between SQLite-backed adapters goes in `@haverstack/sqlite-shared`**, an internal package. Keeping schema DDL, the cursor codec, and the CRUD logic in one place is what keeps engines from silently drifting and keeps a cursor minted by one decodable by another. Only genuinely engine-specific code (database construction, pragma setup, lifecycle) belongs in the adapter packages.

The package is `private` and **bundled into its consumers at build time** — `record-adapter-sqlite` builds with `tsup` and inlines it, so nothing installing that adapter from the registry resolves `@haverstack/sqlite-shared`. Two consequences when working here: adding an export to `sqlite-shared` does not expand any package's public API, and a new SQLite adapter reuses it by living in this repository rather than by installing it. Adding a `dependencies` entry on it would undo that — it belongs in `devDependencies`.

**Wire-format behavior is pinned by shared fixtures.** `@haverstack/conformance-fixtures` is pure data — no test framework, no adapter, no server. Two independent consumers exercise the same fixtures: `adapter-api`'s tests, and any server implementation. A change to the wire contract updates the fixtures, the spec, and the implementation together.

---

## Testing conventions

Tests use [Vitest](https://vitest.dev/) and live in each package's `tests/` directory.

`@haverstack/core/testing` exports the shared test doubles:

- **`MemoryAdapter`** — an in-memory `StackAdapter` implementing the full `RecordFilter` shape, so permission logic under test exercises real predicates rather than an adapter that quietly ignores filters. It declares `contentFieldQuery: true`, as every local adapter must.
- **`IncapableMemoryAdapter`** — declares `contentFieldQuery: false`, simulating the one legitimate case (a wire adapter whose server declined the capability). Use it to exercise capability-gated fallback paths; don't reach for a `false` override on `MemoryAdapter`.

Name tests after the behavior they pin, not the defect that prompted them. `'a grant beyond the first page (>50 _grant records) is still honored'` survives refactoring; `'regression for #50'` doesn't.

---

## Where things live

```
docs/
  spec.md                 # Design spec — overview and index
  spec/                   # Data model, identity, access control, versioning,
                          #   attachments, adapters, wire format
  commons/                # Schema Commons — shared, app-neutral record types
packages/
  core/                   # Stack, ScopedStack, types, schema, validation, MemoryAdapter
  sqlite-shared/          # Internal: shared SQL logic, bundled into consumers, not published
  record-adapter-sqlite/  # Node native SQLite (node:sqlite), FTS5, WAL
  blob-adapter-disk/      # Content-addressed blobs on disk
  adapter-local/          # Convenience: SQLite records + disk blobs
  adapter-api/            # HTTP client for stack servers
  wire-types/             # Wire serialization shapes and error mapping
  conformance-fixtures/   # Wire-format fixtures shared by client and server
```
