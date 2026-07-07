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
await stack.defineType('org.haverstack/contact@1', 'Contact', {
  name: { kind: 'string', required: true },
  emails: { kind: 'array', items: { kind: 'string' } },
  phones: { kind: 'array', items: { kind: 'string' } },
  urls: { kind: 'array', items: { kind: 'string' } },
  org: { kind: 'string' },
  note: { kind: 'text' },
});
```

## Field semantics

| Field    | Kind            | Required | Meaning                                                                                                                                                                                                                                                      |
| -------- | --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`   | `string`        | yes      | Display name, as the user knows them. No given/family split in @1 — name-order and name-structure assumptions are a known internationalization trap; a structured-name addition should arrive as a follow-up optional field, never by reinterpreting `name`. |
| `emails` | `array<string>` | no       | Email addresses, most-preferred first. Plain addresses, no `mailto:`.                                                                                                                                                                                        |
| `phones` | `array<string>` | no       | Phone numbers, most-preferred first. Stored as entered; E.164 normalization is app-side display logic.                                                                                                                                                       |
| `urls`   | `array<string>` | no       | Websites/profiles, most-preferred first.                                                                                                                                                                                                                     |
| `org`    | `string`        | no       | Organization/affiliation, freeform.                                                                                                                                                                                                                          |
| `note`   | `text`          | no       | Freeform notes about the contact.                                                                                                                                                                                                                            |

Arrays are ordered but unlabeled in @1 (no `home`/`work` typing) — labels are the first
candidate follow-up proposal, and per the additive rules they would arrive as a parallel
optional structure, not a reshape of these arrays. Note that array fields are opaque to
the query engine; apps filter contacts by `name` or via associations, not by address.

## Conventions

- **Avatar**: attachment association with label `avatar` — the spec's own example of an
  attachment association, honored here.
- **Contact ↔ entity linkage**: when a contact _is_ a known principal (they appear in
  grants, groups, or authorship), link the records with
  `{ kind: 'relationship', label: 'entity', recordId: <_entity record id> }` on the
  contact. This keeps the directory entry (mutable, user-owned petname territory) apart
  from the identity record, in line with the properties-vs-perspectives principle and
  the DID identity direction (#49): your name for someone is your perspective; their key
  is a property.
- **Grouping** (family, team, club): tag associations for casual grouping. A commons
  position on linking contacts to `_group` records is deferred until the group reshape
  (#58) settles.
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
- Typed/labeled addresses (`home`/`work`) — future proposal.
- Postal addresses — genuinely structured, rarely shared between apps; future proposal
  with vCard `ADR` as prior art.
- `birthday` and dates — see conventions.
- Any identity/key material — that is `_entity`/#49 territory; a contact asserts
  nothing cryptographic.

## Changelog

- **Draft** — initial definition: `name` (required), `emails`, `phones`, `urls`, `org`,
  `note`.
