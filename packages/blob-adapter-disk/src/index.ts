/**
 * Haverstack — Disk Blob Adapter
 * -------------------------------------------------------
 * Implements StackBlobAdapter by storing content-addressed
 * blobs on the local filesystem. File IDs are SHA-256 hashes
 * of the content, enabling deduplication: if a file with the
 * same hash already exists it is not overwritten.
 *
 * Writes land at their content-addressed path via a temp file
 * plus atomic rename, so a crash mid-write can never leave a
 * torn blob at its final, hash-named path.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, existsSync } from 'fs';
import { readFile, writeFile, unlink, readdir, stat, rename } from 'fs/promises';
import { join } from 'path';
import { StackNotFoundError, StackQueryError } from '@haverstack/core';
import type { StackBlobAdapter, BlobFileInfo, FileId } from '@haverstack/core';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const assertFileId = (fileId: string): void => {
  if (!SHA256_HEX_RE.test(fileId)) {
    throw new StackQueryError(`Invalid fileId: expected 64-character lowercase hex string`);
  }
};

export class DiskBlobAdapter implements StackBlobAdapter {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async putAttachment(data: Uint8Array): Promise<FileId> {
    const fileId = createHash('sha256').update(data).digest('hex');
    const finalPath = join(this.dir, fileId);
    if (!existsSync(finalPath)) {
      const tempPath = join(this.dir, `.tmp-${fileId}-${randomBytes(8).toString('hex')}`);
      try {
        await writeFile(tempPath, data);
        await rename(tempPath, finalPath);
      } catch (err) {
        await unlink(tempPath).catch(() => {});
        throw err;
      }
    }
    return fileId;
  }

  async getAttachment(fileId: FileId): Promise<Uint8Array> {
    assertFileId(fileId);
    if (!existsSync(join(this.dir, fileId)))
      throw new StackNotFoundError(`Attachment not found: "${fileId}"`);
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
