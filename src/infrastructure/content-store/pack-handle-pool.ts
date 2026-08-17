import {
  type CatalogFileIdentity,
  type CatalogPackHandle,
  PackCatalog,
} from "./pack-catalog.ts";
import type { PackId } from "./pack.ts";

interface CachedPackHandle {
  readonly pending: Promise<CatalogPackHandle | undefined>;
  users: number;
  retirement?: Promise<void>;
  resolveIdle?: () => void;
}

export interface PackHandleLease {
  readonly handle: CatalogPackHandle;
  /** Idempotently release this operation's right to use the handle. */
  release(): Promise<void>;
}

export type PackHandleAcquireResult =
  | { readonly kind: "acquired"; readonly lease: PackHandleLease }
  | { readonly kind: "missing" }
  | {
      readonly kind: "identity-mismatch";
      readonly actual: CatalogFileIdentity;
    };

export class PackHandlePoolClosedError extends Error {
  constructor() {
    super("pack handle pool is closed");
    this.name = "PackHandlePoolClosedError";
  }
}

function sameIdentity(
  left: CatalogFileIdentity,
  right: CatalogFileIdentity,
): boolean {
  return (
    left.path === right.path &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/**
 * An operation-owned, bounded LRU of authenticated pack handles. A permit is
 * held for the complete lease, so recursive readers can prove that no more
 * than `maximumHandles` descriptors are in use or retained by this pool.
 */
export class PackHandlePool {
  readonly #catalog: PackCatalog;
  readonly #maximumHandles: number;
  readonly #entries = new Map<PackId, CachedPackHandle>();
  readonly #waiters: Array<() => void> = [];
  #availablePermits: number;
  #activeLeases = 0;
  #closed = false;
  #drainWaiter: Promise<void> | undefined;
  #resolveDrain: (() => void) | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(catalog: PackCatalog, maximumHandles = 2) {
    if (!Number.isSafeInteger(maximumHandles) || maximumHandles <= 0) {
      throw new RangeError("maximum pack handles must be a positive integer");
    }
    this.#catalog = catalog;
    this.#maximumHandles = maximumHandles;
    this.#availablePermits = maximumHandles;
  }

  async acquire(
    packId: PackId,
    expectedIdentity?: CatalogFileIdentity,
  ): Promise<PackHandleAcquireResult> {
    await this.#takePermit();
    if (this.#closed) {
      this.#returnPermit();
      throw new PackHandlePoolClosedError();
    }
    let entry: CachedPackHandle;
    try {
      entry = await this.#reserve(packId);
    } catch (error) {
      this.#returnPermit();
      throw error;
    }

    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      entry!.users -= 1;
      try {
        if (entry!.users === 0) {
          entry!.resolveIdle?.();
          delete entry!.resolveIdle;
          if (entry!.retirement !== undefined) await entry!.retirement;
        }
      } finally {
        this.#activeLeases -= 1;
        this.#returnPermit();
        if (this.#activeLeases === 0) this.#resolveDrain?.();
      }
    };

    let handle: CatalogPackHandle | undefined;
    try {
      handle = await entry.pending;
    } catch (error) {
      if (entry.retirement === undefined) this.#deleteEntry(packId, entry);
      await release();
      throw error;
    }
    if (handle === undefined) {
      if (entry.retirement === undefined) this.#deleteEntry(packId, entry);
      await release();
      return { kind: "missing" };
    }
    if (
      expectedIdentity !== undefined &&
      !sameIdentity(handle.identity, expectedIdentity)
    ) {
      await release();
      return { kind: "identity-mismatch", actual: handle.identity };
    }
    return {
      kind: "acquired",
      lease: Object.freeze({ handle, release }),
    };
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    for (const wake of this.#waiters.splice(0)) wake();
    this.#closePromise = (async () => {
      if (this.#activeLeases !== 0) {
        this.#drainWaiter = new Promise<void>((resolve) => {
          this.#resolveDrain = resolve;
        });
        await this.#drainWaiter;
      }
      const retirements = [...this.#entries].map(([packId, entry]) =>
        this.#retire(packId, entry),
      );
      const failures: unknown[] = [];
      const settled = await Promise.allSettled(retirements);
      for (const result of settled) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "multiple pack handles failed to close",
        );
      }
    })();
    return this.#closePromise;
  }

  /** Retire a stale cached identity without racing an outstanding lease. */
  async invalidate(packId: PackId): Promise<void> {
    const entry = this.#entries.get(packId);
    if (entry === undefined) return;
    const active = entry.users !== 0;
    const retirement = this.#retire(packId, entry);
    if (!active) await retirement;
  }

  async #takePermit(): Promise<void> {
    while (this.#availablePermits === 0 && !this.#closed) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    if (this.#closed) throw new PackHandlePoolClosedError();
    this.#availablePermits -= 1;
  }

  #returnPermit(): void {
    this.#availablePermits = Math.min(
      this.#maximumHandles,
      this.#availablePermits + 1,
    );
    const wake = this.#waiters.shift();
    wake?.();
  }

  async #reserve(packId: PackId): Promise<CachedPackHandle> {
    while (true) {
      if (this.#closed) throw new PackHandlePoolClosedError();
      const cached = this.#entries.get(packId);
      if (cached !== undefined) {
        if (cached.retirement !== undefined) {
          await cached.retirement;
          continue;
        }
        this.#entries.delete(packId);
        this.#entries.set(packId, cached);
        this.#activate(cached);
        return cached;
      }

      if (this.#entries.size < this.#maximumHandles) {
        // Publish and activate the reservation before yielding. Same-id
        // acquisitions therefore share one open, and no zero-user reservation
        // can be mistaken for an evictable cached handle.
        const entry: CachedPackHandle = {
          pending: this.#catalog.openPack(packId),
          users: 0,
        };
        this.#entries.set(packId, entry);
        this.#activate(entry);
        return entry;
      }

      const idle = [...this.#entries].find(
        ([, entry]) => entry.retirement === undefined && entry.users === 0,
      );
      if (idle !== undefined) {
        await this.#retire(idle[0], idle[1]);
        continue;
      }

      const retiring = [...this.#entries.values()].find(
        (entry) => entry.retirement !== undefined && entry.users === 0,
      );
      if (retiring !== undefined) {
        await retiring.retirement;
        continue;
      }

      // A reserved permit proves that fewer than `maximumHandles` leases are
      // active, so a full map must contain an idle or retiring entry.
      throw new Error("pack handle pool capacity invariant was violated");
    }
  }

  #activate(entry: CachedPackHandle): void {
    entry.users += 1;
    this.#activeLeases += 1;
  }

  #retire(packId: PackId, entry: CachedPackHandle): Promise<void> {
    if (entry.retirement !== undefined) return entry.retirement;
    const idle =
      entry.users === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            entry.resolveIdle = resolve;
          });
    const retirement = (async () => {
      await idle;
      const handle = await entry.pending;
      if (handle !== undefined) await handle.close();
      this.#deleteEntry(packId, entry);
    })();
    entry.retirement = retirement;
    return retirement;
  }

  #deleteEntry(packId: PackId, entry: CachedPackHandle): void {
    if (this.#entries.get(packId) !== entry) return;
    this.#entries.delete(packId);
  }
}
