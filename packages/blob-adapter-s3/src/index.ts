/**
 * Haverstack — S3 Blob Adapter
 * -------------------------------------------------------
 * Implements StackBlobAdapter over the S3 API, storing
 * content-addressed blobs keyed by the SHA-256 hash of their
 * bytes. Pass `endpoint` + `forcePathStyle` to target an
 * S3-compatible store (e.g. Cloudflare R2) instead of AWS S3
 * itself — the rest of the adapter is identical either way.
 *
 * Unlike blob-adapter-disk, no temp-file-plus-rename dance is
 * needed: S3's PutObject is atomic per key, so two callers
 * writing the same content-addressed key concurrently just
 * write the same bytes twice — never a torn object.
 */

import { createHash } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { StackNotFoundError, StackQueryError } from '@haverstack/core';
import type { FileId } from '@haverstack/core';
import type { StackBlobAdapter, BlobFileInfo } from '@haverstack/core/adapter';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const assertFileId = (fileId: string): void => {
  if (!SHA256_HEX_RE.test(fileId)) {
    throw new StackQueryError(`Invalid fileId: expected 64-character lowercase hex string`);
  }
};

export type S3BlobAdapterOptions = {
  /** Bucket to store blobs in. */
  bucket: string;
  /**
   * A pre-configured S3Client, for callers who need control over retry
   * policy, credential providers, request middleware, etc. When omitted,
   * a client is built from the remaining options.
   */
  client?: S3Client;
  /** AWS region. Ignored when `client` is provided. */
  region?: string;
  /**
   * Custom endpoint — set this together with `forcePathStyle` to target an
   * S3-compatible store (e.g. Cloudflare R2's S3 endpoint) instead of AWS
   * S3. Ignored when `client` is provided.
   */
  endpoint?: string;
  /** Ignored when `client` is provided. */
  forcePathStyle?: boolean;
  /** Ignored when `client` is provided. */
  credentials?: S3ClientConfig['credentials'];
};

export class S3BlobAdapter implements StackBlobAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3BlobAdapterOptions) {
    this.bucket = options.bucket;
    this.client =
      options.client ??
      new S3Client({
        region: options.region,
        endpoint: options.endpoint,
        forcePathStyle: options.forcePathStyle,
        credentials: options.credentials,
      });
  }

  private async objectExists(fileId: FileId): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: fileId }));
      return true;
    } catch (err) {
      if (err instanceof NotFound) return false;
      throw err;
    }
  }

  async putAttachment(data: Uint8Array): Promise<FileId> {
    const fileId = createHash('sha256').update(data).digest('hex');
    if (!(await this.objectExists(fileId))) {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: fileId, Body: data }),
      );
    }
    return fileId;
  }

  async getAttachment(fileId: FileId): Promise<Uint8Array> {
    assertFileId(fileId);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: fileId }),
      );
      return await response.Body!.transformToByteArray();
    } catch (err) {
      if (err instanceof NoSuchKey) {
        throw new StackNotFoundError(`Attachment not found: "${fileId}"`);
      }
      throw err;
    }
  }

  async deleteAttachment(fileId: FileId): Promise<void> {
    assertFileId(fileId);
    // S3's DeleteObject is idempotent — a missing key is treated as
    // already-deleted rather than an error, so no non-fatal catch is
    // needed here the way blob-adapter-disk needs one for fs semantics.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: fileId }));
  }

  async listFiles(): Promise<BlobFileInfo[]> {
    const files: BlobFileInfo[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: continuationToken }),
      );
      for (const obj of response.Contents ?? []) {
        if (obj.Key && SHA256_HEX_RE.test(obj.Key) && obj.Size !== undefined && obj.LastModified) {
          files.push({ fileId: obj.Key, size: obj.Size, modifiedAt: obj.LastModified });
        }
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return files;
  }
}
