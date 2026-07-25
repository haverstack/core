/**
 * Haverstack — Disk Blob Adapter
 * -------------------------------------------------------
 * Implements StackBlobAdapter by storing content-addressed
 * blobs on the local filesystem. File IDs are SHA-256 hashes
 * of the content, enabling deduplication: if a file with the
 * same hash already exists it is not overwritten.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'fs';
import { readFile, writeFile, unlink, readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { StackBlobAdapter, BlobFileInfo, FileId, StackRecord } from '@haverstack/core';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const assertFileId = (fileId: string): void => {
  if (!SHA256_HEX_RE.test(fileId)) {
    throw new Error(`Invalid fileId: expected 64-character lowercase hex string`);
  }
};

export class DiskBlobAdapter implements StackBlobAdapter {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async putAttachment(data: Uint8Array): Promise<FileId> {
    const fileId = createHash('sha256').update(data).digest('hex');
    if (!existsSync(join(this.dir, fileId))) {
      await writeFile(join(this.dir, fileId), data);
    }
    return fileId;
  }

  /** Bytes storage only — this adapter has no access to record creation, a different backend. */
  async tryPutAttachmentWithMetadata(
    data: Uint8Array,
    _mimeType: string,
    _filename?: string,
  ): Promise<{ fileId: FileId; record?: StackRecord }> {
    return { fileId: await this.putAttachment(data) };
  }

  async getAttachment(fileId: FileId): Promise<Uint8Array> {
    assertFileId(fileId);
    if (!existsSync(join(this.dir, fileId))) throw new Error(`Attachment not found: "${fileId}"`);
    return readFile(join(this.dir, fileId));
  }

  async deleteAttachment(fileId: FileId): Promise<void> {
    assertFileId(fileId);
    try {
      await unlink(join(this.dir, fileId));
    } catch {
      // Non-fatal — file may already be gone.
    }
  }

  async listFiles(): Promise<BlobFileInfo[]> {
    const entries = await readdir(this.dir);
    const fileIds = entries.filter((name) => SHA256_HEX_RE.test(name));
    return Promise.all(
      fileIds.map(async (fileId) => {
        const stats = await stat(join(this.dir, fileId));
        return { fileId, size: stats.size, modifiedAt: stats.mtime };
      }),
    );
  }
}
