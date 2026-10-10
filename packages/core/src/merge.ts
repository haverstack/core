/**
 * Stack — RFC 7396 JSON Merge Patch
 * -------------------------------------------------------
 * Shallow merge-patch semantics for record content: a field set to `null`
 * removes it, any other value replaces it, and omitted fields are retained.
 * Shared by Stack.mutate() (for client-side validation) and every
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
      // defineProperty, not assignment: [[Set]] on `__proto__` would
      // reassign the prototype and lose the write, while an own data
      // property is what JSON.parse makes of the same key, so both write
      // paths agree. A backstop for adapters calling this directly; Stack
      // refuses the reserved keys outright (validateReservedKeys).
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
