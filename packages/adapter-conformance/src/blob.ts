/**
 * Blob adapter conformance suite
 * -------------------------------------------------------
 * The blob half of the adapter contract is small (StackBlobAdapter is three
 * required methods plus one optional one) but has the same failure shape as
 * the record half: content-addressing and the fileId error contract are
 * documented in prose and easy to get subtly wrong in a from-scratch
 * implementation — a fileId that isn't actually the SHA-256 of the bytes
 * it names breaks any caller that compares fileIds instead of re-fetching,
 * and a malformed fileId misreported as `not_found` instead of `bad_request`
 * hides a caller bug behind the wrong error class.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type { StackBlobAdapter } from '@haverstack/core/adapter';
import { expectStackErrorCode } from './errors.js';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface BlobAdapterConformanceOptions {
  /** Used in describe() titles. */
  name: string;
  /** Produce a fresh, empty adapter instance. Called before every test. */
  open: () => Promise<StackBlobAdapter> | StackBlobAdapter;
  /** Release what `open()` acquired. Called after every test. */
  close?: (adapter: StackBlobAdapter) => Promise<void> | void;
  /**
   * Whether this adapter implements the optional `listBlobs()`. Passed
   * explicitly, like `capabilities` in the record suite, so the listBlobs
   * describe block can be registered or skipped at vitest's synchronous
   * collection time rather than probed off an opened instance.
   */
  listBlobs?: boolean;
}

export function runBlobAdapterConformance(options: BlobAdapterConformanceOptions): void {
  const { name, open, close, listBlobs = false } = options;

  describe(`blob adapter conformance: ${name}`, () => {
    let adapter: StackBlobAdapter;

    // `open()` can reject; `adapter` is then unset (or still holds the
    // previous test's, already closed). Closing either way throws over
    // the top of the real initialization error and hides it.
    let opened = false;

    beforeEach(async () => {
      opened = false;
      adapter = await open();
      opened = true;
    });

    afterEach(async () => {
      if (!opened) return;
      opened = false;
      await close?.(adapter);
    });

    test('putBlob returns the SHA-256 hex of the stored bytes', async () => {
      const data = new TextEncoder().encode('hello attachment');
      const fileId = await adapter.putBlob(data);
      expect(fileId).toMatch(SHA256_HEX_RE);
      expect(fileId).toBe(await sha256Hex(data));
    });

    test('getBlob returns exactly the bytes that were stored', async () => {
      const data = new TextEncoder().encode('roundtrip me');
      const fileId = await adapter.putBlob(data);
      const retrieved = await adapter.getBlob(fileId);
      expect(new Uint8Array(retrieved)).toEqual(data);
    });

    test('putBlob is content-addressed — identical bytes yield the same fileId', async () => {
      const data = new TextEncoder().encode('same content twice');
      const first = await adapter.putBlob(data);
      const second = await adapter.putBlob(data);
      expect(first).toBe(second);
    });

    test('getBlob reports not_found for a well-formed but unknown fileId', async () => {
      const neverStored = 'a'.repeat(64);
      await expectStackErrorCode(adapter.getBlob(neverStored), 'not_found');
    });

    test('getBlob reports bad_request for a malformed fileId', async () => {
      await expectStackErrorCode(adapter.getBlob('not-a-sha256-hash'), 'bad_request');
    });

    test('deleteBlob removes the blob — a later getBlob reports not_found', async () => {
      const fileId = await adapter.putBlob(new TextEncoder().encode('temporary'));
      await adapter.deleteBlob(fileId);
      await expectStackErrorCode(adapter.getBlob(fileId), 'not_found');
    });

    test('deleteBlob is non-fatal for a fileId that was never stored', async () => {
      await expect(adapter.deleteBlob('b'.repeat(64))).resolves.toBeUndefined();
    });

    if (listBlobs) {
      describe('listBlobs', () => {
        test('returns an empty array for an empty store', async () => {
          expect(await adapter.listBlobs!()).toEqual([]);
        });

        test('lists every stored blob with its fileId, size and modifiedAt', async () => {
          const data = new TextEncoder().encode('a stored blob');
          const fileId = await adapter.putBlob(data);

          const files = await adapter.listBlobs!();
          const entry = files.find((f) => f.fileId === fileId);
          expect(entry?.size).toBe(data.byteLength);
          expect(entry?.modifiedAt).toBeInstanceOf(Date);
        });

        test('a deleted blob no longer appears', async () => {
          const fileId = await adapter.putBlob(new TextEncoder().encode('gone soon'));
          await adapter.deleteBlob(fileId);
          const files = await adapter.listBlobs!();
          expect(files.some((f) => f.fileId === fileId)).toBe(false);
        });
      });
    }
  });
}
