# Security Policy

Haverstack holds personal data and the keys that speak for its owner. This document says what to do when you find a weakness in it, and which parts of the system carry a security promise at all.

## Reporting a vulnerability

**Report privately, through [GitHub Security Advisories](https://github.com/haverstack/core/security/advisories/new).** That opens a channel visible only to you and the maintainers. Please don't open a public issue or PR for a suspected vulnerability — a public report is a disclosure, and it lands before there's anything to upgrade to.

Include what you have: the version or commit, what an attacker gets, and the smallest reproduction you can manage. A failing test against this repo is the most useful form, but prose is fine — a clear description of the wrong behavior beats a polished exploit.

Expect an acknowledgement within a week. If a report is valid, you'll get the fix plan and the release it lands in; if it isn't, you'll get the reasoning, which is often the more interesting answer. Credit in the advisory unless you'd rather not be named.

Nothing here is a bug bounty — this is a public-domain project with no budget behind it.

## What is in scope

This repository: `@haverstack/core` and the adapter, wire and commons packages beside it.

The reference server lives in [`haverstack/server`](https://github.com/haverstack/server) and takes reports the same way, in its own repository. If you aren't sure which side a finding sits on, report it here and say so.

**Especially interesting**, because they're where a mistake is least visible:

- Anything that lets a requester read or write a Record the [access-control model](./docs/spec/access-control.md) says they cannot — particularly through delegation, where authority is the intersection of an app's and a person's.
- A signature that verifies where it shouldn't: replay across origins, a challenge redeemed against a different server, a `did:key` that parses to the wrong key.
- Input that escapes the [error taxonomy](./docs/spec/wire-format.md#the-taxonomy-root) as a raw engine error, or that reaches SQL as syntax rather than as a bound parameter.
- An attachment served with a Content-Type that lets a browser execute it — see the [download policy](./docs/spec/wire-format.md#download).
- Anything that discloses whether a Record exists to someone who couldn't read it.

## What is not a vulnerability

These are documented properties, not oversights. Each is a design decision with its reasoning in the spec; argue with the decision by opening an issue, not an advisory.

- **Direct `adapter-local` access is full trust.** `Stack` is unscoped, `appId` is self-reported, and grants aren't checked. Sharing a stack file between apps is not a supported arrangement — that's what a server and `adapter-api` are for. See [Adapters § Concurrency & storage ownership](./docs/spec/adapters.md#concurrency--storage-ownership).
- **A lost `did:key` private key is unrecoverable**, and key rotation is deliberately deferred. See [Identity § Deferred: key rotation](./docs/spec/identity.md#deferred-key-rotation).
- **Nothing in this repository stores a private key.** Where it lives is the app's decision; see [Key custody](./README.md#key-custody) for the postures we recommend.
- **A `-own` action does not contain a delegated app.** When an app acts for someone, `-own` reads as the bare verb — the type list is the containment. See [Access control § Delegation](./docs/spec/access-control.md#delegation-principal-and-subject).
- **Query cost is not bounded by this library.** Both SQLite engines run synchronously in-process with no way to interrupt a running statement. A server serving many requesters owes its own limit; see [Wire format § Bounding query cost](./docs/spec/wire-format.md#bounding-query-cost).
- **Rate limiting and abuse control are the server's.** The permission model answers "may this requester do this", not "how often".

## Supported versions

Every package here is `0.x` and APIs are unstable. Fixes land on `main` and ship in the next release; there are no maintained release branches and no backports to older minors. The practical advice is to track the latest version.
