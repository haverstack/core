import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock } from '../src/lock.js';

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `sqlite-shared-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  dbPath = join(testDir, 'test.db');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('acquireLock / releaseLock', () => {
  test('acquireLock creates a lock file stamped with the current pid', () => {
    acquireLock(dbPath);
    expect(existsSync(`${dbPath}.lock`)).toBe(true);
    const info = JSON.parse(readFileSync(`${dbPath}.lock`, 'utf-8'));
    expect(info.pid).toBe(process.pid);
  });

  test('reacquiring from the same process does not throw', () => {
    acquireLock(dbPath);
    expect(() => acquireLock(dbPath)).not.toThrow();
  });

  test('rejects when a live process already holds the lock', () => {
    const otherPid = process.pid + 1;
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: otherPid }));
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(() => acquireLock(dbPath)).toThrow(/in use by another process \(pid \d+\)/);
  });

  test('reclaims a lock left by a dead process', () => {
    const deadPid = process.pid + 1;
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: deadPid }));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    expect(() => acquireLock(dbPath)).not.toThrow();
  });

  test('force bypasses a live lock', () => {
    const otherPid = process.pid + 1;
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: otherPid }));
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(() => acquireLock(dbPath, true)).not.toThrow();
  });

  test('releaseLock removes a lock owned by this process', () => {
    acquireLock(dbPath);
    releaseLock(dbPath);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  test('releaseLock is a no-op when no lock file exists', () => {
    expect(() => releaseLock(dbPath)).not.toThrow();
  });

  test('releaseLock does not remove a lock owned by a different pid', () => {
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: process.pid + 1 }));
    releaseLock(dbPath);
    expect(existsSync(`${dbPath}.lock`)).toBe(true);
  });
});
