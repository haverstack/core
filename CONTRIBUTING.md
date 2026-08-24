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

### What a contributor does

Add a changeset to the same PR as the change:

```sh
pnpm changeset
```

It asks which packages moved and by how much, then writes a Markdown file under `.changeset/`. Commit it. A PR with no user-visible effect — a test, a doc fix, a refactor that ships identical output — needs no changeset.

**Name only the packages you actually changed.** Dependents are worked out for you; see [The ripple rule](#the-ripple-rule) below.

### What CI does

`.github/workflows/release.yml` runs on every push to `main`:

- **Changesets are pending** → it opens (and keeps updating) a `chore: version packages` PR that applies every pending changeset: version fields bumped, `CHANGELOG.md` entries written, the changeset files deleted.
- **That PR merges** → the same workflow sees no pending changesets, builds, runs `pnpm run verify:pack`, and publishes the changed packages to npm with `changeset publish`, tagging each release in git.

So a release is one reviewable PR, and merging it is the act of publishing. Whoever can merge to `main` can publish, which is the reason `main` is protected.

### How the publish authenticates

There is no `NPM_TOKEN`, and there should never be one. Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): the workflow requests a short-lived OIDC token from GitHub and npm trades it for publish rights, so no long-lived credential is stored in the repository at all.

That costs some one-time setup, and it is per package. On npmjs.com, each of the eight published packages needs a trusted publisher under its settings:

| Field             | Value           |
| ----------------- | --------------- |
| Publisher         | GitHub Actions  |
| Organization/user | `haverstack`    |
| Repository        | `core`          |
| Workflow filename | `release.yml`   |
| Environment       | _(leave empty)_ |

Three things in `.github/workflows/release.yml` exist only to make this work, and are worth knowing before anyone edits them:

- **`id-token: write`.** Without it GitHub mints no OIDC token and the publish falls back to looking for a credential that isn't there.
- **`actions/setup-node@v7` or newer** — deliberately ahead of the `v4` the CI workflow pins. Earlier majors export a dummy `NODE_AUTH_TOKEN`, and the empty `.npmrc` credential that writes shadows the handshake.
- **pnpm pinned to 10.** `changeset publish` shells out to `pnpm publish`, so pnpm performs the OIDC exchange itself. pnpm 11 regressed it into a 404 ([pnpm/pnpm#11513](https://github.com/pnpm/pnpm/issues/11513)); confirm that is fixed before moving to 11.

Renaming the workflow file breaks every trusted publisher at once, since each one matches on the filename.

Two repository settings also have to be right, both under **Settings → Actions → General**: **Allow GitHub Actions to create and approve pull requests** must be on, or the version PR is silently never opened; and workflow permissions must allow the `contents: write` the workflow asks for.

**Adding a ninth package** means publishing it once by hand — trusted publishing can only be configured on a package that already exists — and then adding its trusted publisher before the next automated release.

**Want a human gate on the publish itself?** Create a GitHub environment (say `npm-publish`) with required reviewers, add `environment: npm-publish` to the release job, and put that same name in the Environment field of every trusted publisher. The two must agree; a mismatch fails the publish. Until you do all three, leave the field empty.

`GITHUB_TOKEN` is provided by Actions and needs no setup.

### Choosing a bump while we are pre-1.0

Every package is on `0.x`, where semver puts breaking changes in the **minor** slot:

| Change                                                              | Bump           |
| ------------------------------------------------------------------- | -------------- |
| Bug fix, docs, internals — nothing a consumer can observe           | `patch`        |
| Renamed or removed exports, changed behavior, a new required option | `minor`        |
| Nothing ships — tests, CI, repo tooling                             | _no changeset_ |

**Don't select `major`.** It would cut a 1.0 release, which is a deliberate decision about the install base (see [No backward compatibility yet](#no-backward-compatibility-yet)) and not something a single PR should make.

`@haverstack/sqlite-shared` is `private`, so Changesets skips it entirely — it has no version to publish. A change confined to it is recorded as a change to `@haverstack/record-adapter-sqlite`, the package that bundles it and actually ships.

### The ripple rule

Packages depend on each other through `workspace:^`, and on `0.x` a caret accepts patches but not minors. That single fact decides both directions:

- **A `patch` to `@haverstack/core` moves nothing else.** `^0.11.1` already accepts `0.11.2`, so no dependent needs republishing — and Changesets leaves them alone on its own.
- **A `minor` to `@haverstack/core` moves every dependent by a `minor` too.** `^0.11.1` rejects `0.12.0`, so each dependent has to be republished against the new core, and a release that carries a breaking change through to its own consumers is breaking in turn.

Changesets gets the first case right unaided but would only patch-bump dependents in the second. `scripts/expand-changesets.mjs` closes that gap: during `pnpm run version:packages` it reads the pending changesets, walks `dependencies` and `peerDependencies` across the workspace, and writes the induced releases as one more changeset before `changeset version` consumes them all.

The rule is transitive and applies to every workspace dependency, not just `core` — a `minor` to `@haverstack/wire-types` minor-bumps `@haverstack/adapter-api` and `@haverstack/conformance-fixtures` the same way. Preview it any time with:

```sh
node scripts/expand-changesets.mjs --dry-run
```

The script reads "breaking" off each package's own version rather than hardcoding `minor`, because the slot semver reserves for breaking changes moves at 1.0. Nothing here needs revisiting when a package graduates.

### Releasing by hand

Only when CI cannot. Both halves of the automation are ordinary scripts:

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
