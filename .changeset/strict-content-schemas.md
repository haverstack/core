---
'@haverstack/core': minor
---

Hold content to the type's schema, and give a schema-less shape a way to say so

**Behavior change: a content field the record's type does not declare is refused
with `StackValidationError` (wire: 422)** — on `create()`, in an `update()` patch,
and on `commitMigration()` against the destination type — naming the field and the
path it sits at. It holds at every depth: an undeclared key inside a declared
`object`, or inside the `object` an `array` declares as its items, is refused with
its full path (`address.postcode`, `emails[1].label`).

The schema is the record's shape. A key outside it is a typo, a stale writer, or a
caller reaching for something that is not content at all, and accepting it makes all
three look like a write that worked. The third is the one that motivated this:
content is its own namespace, so `update(id, { parentId })` writes a content field
of that name and never the native one, leaving a `content.parentId` sitting beside a
native `parentId` holding something else, with nothing downstream reading it. That
now names the field and points the caller back at the verb they wanted.

**The rule is about the schema, not about the names.** A type is free to declare
`parentId`, `version` or `createdAt` as content — a bookmark's `parentId` naming the
upstream record it was clipped from is an ordinary field — and once declared it is
patched like any other. Nothing is reserved by resemblance to a native field, and
the same check catches `titel` and `craetedAt`, which no list of names would.

**New: open containers.** An `object` or `array` field declared `open: true` is not
validated inside — the schema places a container there and says nothing about its
interior. That is the deliberate way to store a shape a schema cannot describe: an
imported blob, a payload whose keys are data, or a heterogeneous or null-bearing
list (a declared array has never accepted a `null` element, so this is the only
spelling for one).

A container now declares either its interior or `open`, never neither: `ArrayFieldDef`
and `ObjectFieldDef` are unions, so `{ kind: 'object' }` on its own no longer
type-checks. Opacity is a claim the schema makes rather than something inferred from
a missing `items`/`properties`, so forgetting to describe a container's elements is a
compile error instead of a silently unchecked field.

An open container is still held to its own kind — an open `object` refuses an array,
an open `array` refuses an object — which is why this is a flag on the container
kinds rather than an "any JSON here" kind of its own: a type that means "a list,
contents unspecified" can still say so. It is exempt from the schema only.
[Content field names](https://github.com/haverstack/core/blob/main/docs/spec/data-model.md#content-field-names)
are still checked at every depth inside one, since that rule is about what a filter
path can address rather than about what the type promised. Query reach is unchanged:
a content path walks into an open container, because the query engine reads the
content rather than the schema.

Open and declared are different shapes, not degrees of one. They hash differently,
so `schemaHash` tells them apart. Changing a type from one to the other is schema
drift in **both** directions — closing an open container refuses content it used to
accept, and opening a declared one accepts content it used to refuse — so neither is
an additive-in-place change, and the remedy is a version bump. `isCompatible()` reads
them the same way: an open candidate satisfies a required container only where the
required side asks nothing of its interior, since a bag promises a consumer nothing
to read.

**Additive-in-place evolution is unchanged in mechanism and narrower in what it
licenses.** Validation runs on write and the schema lives in the stack, so a reader
holding an older idea of a type still reads records carrying fields it was never
taught about, and `update()`'s merge patch still preserves fields the caller didn't
name. What changed is that _writing_ a new field means declaring it first — a
`defineType()` call with the field added, which is already the additive-legal path,
not a version bump.

`update()` validating against the record's **own stored type** rather than the
latest is what keeps this safe across a migration: an unswept `@1` record answers to
`@1`'s schema, so a field that exists only in `@2` is refused until `migrateAll()`
moves the record. A field can only ever be added to a schema in place, so a stored
record cannot accumulate content its own type does not declare.

`__proto__`, `constructor` and `prototype` remain refused as top-level content keys
independently of the schema, including inside an open container. **`defineType()`
now refuses a schema that declares one as a top-level field name** (wire: 422 on
`POST /types`), at exactly the scope the write rule holds — a nested declaration
names a field a record can carry, so it is left alone. A declaration cannot license
what the write rule refuses, so accepting one defined a field no record could carry;
where the declaration was `required`, it defined a type no record could satisfy at
all, since supplying the field is refused as a reserved key and omitting it is
refused as a missing required field. This is the argument `defineType()` already
makes for a field name no filter could address: a schema is a promise that a field is
meaningful.

**For server authors:** this is a `Stack` invariant that a server built on core
inherits through ordinary record validation, and a third content-key rule for a
server mapping request bodies onto storage directly to apply itself. It answers
**422** (code `validation`) on `POST /records`, `PATCH /records/:id`, and
`POST /records/:id/migrate`.
