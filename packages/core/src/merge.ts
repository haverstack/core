/**
 * Stack — RFC 7396 JSON Merge Patch
 * -------------------------------------------------------
 * Shallow merge-patch semantics for record content: a field set to `null`
 * removes it, any other value replaces it, and omitted fields are retained.
 * Shared by Stack.update() (for client-side validation) and every
 * StackRecordAdapter's patchContent() implementation, so a patch produces
 * the same merged content everywhere it's applied.
 */

export function applyMergePatch(
  content: Record<string, unknown>,
  patch: Record<string, unknown | null>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...content };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else {
      // defineProperty, not `merged[key] = value`: assignment goes through
      // [[Set]], so a patch key of `__proto__` would invoke the prototype
      // setter and reassign the object's prototype instead of setting a
      // field — silently losing the write. defineProperty creates an own
      // data property for any key, which is also what JSON.parse does when
      // the same key is read back, so both write paths agree. The spread
      // above is already safe (it copies data properties directly).
      //
      // Stack.create()/update() reject the reserved keys outright (see
      // validateReservedKeys); this is the backstop for adapters that call
      // this directly, and for the day someone deepens the merge.
      Object.defineProperty(merged, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return merged;
}
