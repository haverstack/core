# @haverstack/commons

## 0.13.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`46691c5`](https://github.com/haverstack/core/commit/46691c57f6b3b79f3d008fc29b2382c5eb3da006)]:
  - @haverstack/core@0.19.0

## 0.12.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b), [`d0c0bb2`](https://github.com/haverstack/core/commit/d0c0bb25bae95f1285e2b2a0db980d0c4d215ac2), [`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b)]:
  - @haverstack/core@0.18.0

## 0.11.0

### Minor Changes

- [#221](https://github.com/haverstack/core/pull/221) [`9397db8`](https://github.com/haverstack/core/commit/9397db86737ec2290dd06569fff119b7c386c1e8) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `SITE`, the `org.haverstack/site@1` commons type: `title` and `baseUrl`
  required, `description` and `handle` optional. Lets one personal stack back
  several published sites — a root page's `parentId` names the site it belongs
  to, and a `{ kind: 'relationship', label: 'site', target: { scope: 'record',
recordId } }` association on an `article`, `photo`, `bookmark`, or `post`
  says which site(s) publish it, multi-valued for cross-posting. `page`'s
  `collection` roots scope to a site by composing that association into their
  query rather than storing site membership on the collection. See
  `docs/commons/site.md` and the updated `page.md`/`README.md` conventions.

## 0.10.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`d27cfe4`](https://github.com/haverstack/core/commit/d27cfe4fc09406abda36c1c93f071446e13ef7b8)]:
  - @haverstack/core@0.17.0

## 0.9.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`609c320`](https://github.com/haverstack/core/commit/609c320728ff47cae3997042685a9fc2f7a12150)]:
  - @haverstack/core@0.16.0

## 0.8.0

### Minor Changes

- [#211](https://github.com/haverstack/core/pull/211) [`4fb733c`](https://github.com/haverstack/core/commit/4fb733c0a40d46fd4c192d6e2ac2bdb95458e4c7) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `org.haverstack/post@1` — the broadcast utterance, completing the fourth cell
  (speech / unbounded audience) of the commons' text-type contract 2×2.

  `POST` exports `{ text: required, format, url }`, no date field by design — uttering
  is creating, and a mirrored `publishedAt` would equal `createdAt` on every record. See
  `docs/commons/post.md` for the full rationale and conventions.

## 0.7.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`9edf5d0`](https://github.com/haverstack/core/commit/9edf5d02925fc6db3d829c21e23150abf15d8a8f)]:
  - @haverstack/core@0.15.0

## 0.6.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`7db6eaf`](https://github.com/haverstack/core/commit/7db6eaff9dd96eccbc9e96e7a104f3529aa708c9)]:
  - @haverstack/core@0.14.0

## 0.5.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`d556069`](https://github.com/haverstack/core/commit/d5560696f3ec1d08e9d49f66b79cbf2f5036dfef)]:
  - @haverstack/core@0.13.0

## 0.4.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`779ddd6`](https://github.com/haverstack/core/commit/779ddd6599c8b9049ca6fbf1516a4a54705e9609)]:
  - @haverstack/core@0.12.0
