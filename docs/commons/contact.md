# `org.haverstack/contact@1` — Contact

> **Status:** Draft.

A person or organization in the user's address book. Distinct from the `_entity` system
type: an `_entity` is a principal — an authenticated actor in the permission system — while
a `contact` is a directory entry, with no implied cryptographic identity. Most contacts
will never be entities; some will be both (see conventions).

Prior art is vCard, and the design here is a deliberately tiny vCard subset: the fields
people actually fill in, minus the 40 years of accretion.

## Schema

```ts
const labeledValue = {
  kind: 'object',
  properties: {
    value: { kind: 'string', required: true },
    label: { kind: 'string' },
  },
} as const;

await stack.defineType('org.haverstack/contact@1', 'Contact', {
  name: { kind: 'string', required: true },
  emails: { kind: 'array', items: labeledValue },
  phones: { kind: 'array', items: labeledValue },
  urls: { kind: 'array', items: labeledValue },
  org: { kind: 'string' },
  note: { kind: 'text' },
});
```

## Field semantics

| Field    | Kind                     | Required | Meaning                                                                                                                                                                                                                                                      |
| -------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`   | `string`                 | yes      | Display name, as the user knows them. No given/family split in @1 — name-order and name-structure assumptions are a known internationalization trap; a structured-name addition should arrive as a follow-up optional field, never by reinterpreting `name`. |
| `emails` | `array<{value, label?}>` | no       | Email addresses, most-preferred first. `value` is the plain address (no `mailto:`); `label` is an optional user-facing word.                                                                                                                                 |
| `phones` | `array<{value, label?}>` | no       | Phone numbers, most-preferred first. `value` stored as entered (E.164 normalization is app-side display logic); `label` as below.                                                                                                                            |
| `urls`   | `array<{value, label?}>` | no       | Websites/profiles, most-preferred first.                                                                                                                                                                                                                     |
| `org`    | `string`                 | no       | Organization/affiliation, freeform.                                                                                                                                                                                                                          |
| `note`   | `text`                   | no       | Freeform notes about the contact.                                                                                                                                                                                                                            |

**Labels** (vCard's `TYPE` parameter, humanized): an open vocabulary of user-facing
words. Well-known values: `"home"`, `"work"`, `"mobile"`. Unknown labels are displayed
verbatim — they are the user's words ("boat phone" is legal and correct), not a
machine namespace. Absent means unspecified.

These are **directory data the user typed**, not machine identifiers. The resemblance
to a relationship's `{ scope: 'external', ns, id }` target is superficial and the two
do different jobs: an `alias` relationship is what an app resolves an inbound record's
author _through_, while `contact.emails` is what a person reads. A contact that is also
a known principal carries both — see the conventions below.

Note that array fields are opaque to the query engine; apps filter contacts by `name`
or via associations, not by address.

## Conventions

- **Avatar**: attachment association with label `avatar` — the spec's own example of an
  attachment association, honored here.
- **Alias identifiers**: a machine identifier for someone in another system —
  `did:plc:…`, an ActivityPub actor URL, an npub — is an `alias` relationship with an
  external target, on the `_entity` record rather than here. See
  [Cross-type conventions](./README.md#cross-type-conventions).
- **Contact ↔ entity linkage**: when a contact _is_ a known principal (they appear in
  grants, groups, or authorship), link the records with
  `{ kind: 'relationship', label: 'entity', recordId: <_entity record id> }` on the
  contact. This keeps the directory entry (mutable, user-owned petname territory) apart
  from the identity record, in line with the properties-vs-perspectives principle and
  the DID identity model: your name for someone is your perspective; their key is a
  property.
- **Grouping** (family, team, club): tag associations for casual grouping. A commons
  position on linking contacts to `_group` records has not been proposed yet.
- **Birthdays**: excluded from @1 — calendar-shaped data (partial dates, year-unknown
  birthdays, recurrence) belongs with the future `event` proposal.

## Read-compat core

```ts
{ name: { kind: 'string', required: true } }
```

Minimal by intent: anything nameable — an `_entity`, an app's `author` type, a CRM
lead — can be listed by a contacts consumer.

## Deliberately excluded

- Structured names (`givenName`/`familyName`) — i18n trap; future optional addition.
- Postal addresses — genuinely structured, rarely shared between apps; future proposal
  with vCard `ADR` as prior art.
- `birthday` and dates — see conventions.
- Any identity/key material — that is `_entity` territory; a contact asserts nothing
  cryptographic.

## Changelog

- **Draft** — initial definition: `name` (required), `emails`, `phones`, `urls`, `org`,
  `note`.
- **Draft, reshaped in place** — `emails`/`phones`/`urls` items changed from bare
  strings to `{ value, label? }` objects (vCard `TYPE`, humanized). An in-place item
  reshape is legal exactly once: pre-install-base, per the project's evolution stance —
  the cheap window this project's own doctrine says to use.
