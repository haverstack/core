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
import { StackNotFoundError, StackBadRequestError } from '@haverstack/core';
import type { FileId } from '@haverstack/core';
import { FILE_ID_RE, WriteHead, blobWindow } from '@haverstack/core/adapter';
import type { StackBlobAdapter, BlobInfo, BlobsQuery } from '@haverstack/core/adapter';

const assertFileId = (fileId: string): void => {
  if (!FILE_ID_RE.test(fileId)) {
    throw new StackBadRequestError(`Invalid fileId: expected 64-character lowercase hex string`);
  }
};

export type DiskBlobAdapterOptions = {
  /** Directory to store blobs in. Created if it doesn't exist. */
  dir: string;
};

export class DiskBlobAdapter implements StackBlobAdapter {
  /** Moved by every putBlob() and deleteBlob(); see head(). */
  private readonly written = new WriteHead();
  private readonly dir: string;

  constructor(options: DiskBlobAdapterOptions) {
    this.dir = options.dir;
    mkdirSync(this.dir, { recursive: true });
  }

  async putBlob(data: Uint8Array): Promise<FileId> {
    this.written.moved();
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

  async getBlob(fileId: FileId): Promise<Uint8Array> {
    assertFileId(fileId);
    if (!existsSync(join(this.dir, fileId)))
      throw new StackNotFoundError(`Attachment not found: "${fileId}"`);
    const buf = await readFile(join(this.dir, fileId));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async deleteBlob(fileId: FileId): Promise<void> {
    this.written.moved();
    assertFileId(fileId);
    try {
      await unlink(join(this.dir, fileId));
    } catch {
      // Non-fatal — file may already be gone.
    }
  }

  async listBlobs(query?: BlobsQuery): Promise<BlobInfo[]> {
    const entries = await readdir(this.dir);
    const fileIds = blobWindow(
      entries.filter((name) => FILE_ID_RE.test(name)),
      query,
    );
    return Promise.all(
      fileIds.map(async (fileId) => {
        const stats = await stat(join(this.dir, fileId));
        return { fileId, size: stats.size, modifiedAt: stats.mtime };
      }),
    );
  }

  async head(): Promise<string> {
    return this.written.read();
  }
}
