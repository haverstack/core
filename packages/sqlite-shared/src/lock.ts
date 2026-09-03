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
  const info = existsSync(lockPath) ? readLock(lockPath) : null;
  if (info) {
    const ownedBySelf = info.pid === process.pid;
    if (!ownedBySelf && !force && isProcessAlive(info.pid)) {
      throw new Error(
        `Stack database at "${dbPath}" is in use by another process (pid ${info.pid}). ` +
          `Connect via its server instead, or pass { force: true } to override. ` +
          `If no such process is running, remove "${lockPath}".`,
      );
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid } satisfies LockInfo));
};

/**
 * Read the lock, treating an unreadable one as absent. A lock file is
 * written non-atomically, so a crash mid-write leaves a torn one — and a
 * lock naming no live process is exactly what acquireLock() reclaims. The
 * alternative is a database that cannot be opened again by any means the
 * error message mentions, which is the worse failure: the lock exists to
 * prevent a second writer, not to outrank the data it guards.
 * releaseLock() takes the same view.
 */
const readLock = (lockPath: string): LockInfo | null => {
  try {
    const info = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockInfo;
    return typeof info?.pid === 'number' ? info : null;
  } catch {
    return null;
  }
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
