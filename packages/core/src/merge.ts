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
      merged[key] = value;
    }
  }
  return merged;
}
