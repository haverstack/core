/**
 * The SHA-256 hex digest core names things by: a file's bytes (its
 * FileId), a schema's canonical form (its schemaHash), an install plan's
 * canonical form (its fingerprint). One helper, so every one of them is
 * the same lowercase hex over the same encoding.
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
