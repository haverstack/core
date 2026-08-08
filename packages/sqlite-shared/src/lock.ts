/**
 * Storage-ownership lock file. A stack file is owned by exactly one
 * process at a time (see docs/spec/adapters.md § Concurrency & storage ownership).
 * The lock file sits beside the database and records the PID of its
 * opener — pure Node fs/process logic, no SQLite engine involved, so
 * every Node-backed record adapter shares one implementation and one
 * error message.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';

type LockInfo = { pid: number };

const lockPathFor = (dbPath: string): string => `${dbPath}.lock`;

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process — safe to reclaim. Anything else (e.g. EPERM,
    // meaning the process exists but we can't signal it) — assume alive.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

/**
 * Acquire the lock, throwing a clear error if another live process
 * already holds it. Reclaims stale locks (owning process no longer
 * running) automatically. `force` bypasses the check entirely, for the
 * rare case of PID reuse across a reboot.
 */
export const acquireLock = (dbPath: string, force?: boolean): void => {
  const lockPath = lockPathFor(dbPath);
  if (existsSync(lockPath)) {
    const info = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockInfo;
    const ownedBySelf = info.pid === process.pid;
    if (!ownedBySelf && !force && isProcessAlive(info.pid)) {
      throw new Error(
        `Stack database at "${dbPath}" is in use by another process (pid ${info.pid}). ` +
          `Connect via its server instead, or pass { force: true } to override.`,
      );
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid } satisfies LockInfo));
};

/** Release the lock, if it's still owned by this process. */
export const releaseLock = (dbPath: string): void => {
  const lockPath = lockPathFor(dbPath);
  if (!existsSync(lockPath)) return;
  try {
    const info = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockInfo;
    if (info.pid === process.pid) unlinkSync(lockPath);
  } catch {
    // Corrupt lock file — remove it rather than leaving storage permanently unopenable.
    unlinkSync(lockPath);
  }
};
