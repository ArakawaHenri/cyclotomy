import { createHash } from "node:crypto";

import {
  CHUNKED_CONTENT_MIN_BYTES,
  ChunkedContentPlanBuilder,
  type RecipeGraphLimits,
} from "./chunk-recipe.ts";
import { contentIdFromBytes, parseContentId, parseMetadataId } from "./ids.ts";
import { encodePack, packClassForRecordKind, type PackClass } from "./pack.ts";
import type {
  CatalogPackIdentityReceipt,
  PublishedCatalogPack,
} from "./pack-catalog.ts";
import type { RecordEnvelope } from "./record.ts";
import {
  ContentRepositoryError,
  type ContentRepositoryResolutionScope,
  type ContentPublicationOptions,
  type ContentStreamSource,
  type PublishedContent,
  type StructuralRecordKind,
} from "./repository.ts";
import {
  createChunkedContentRecord,
  createRecipeRecord,
  encodeOwnedPayload,
} from "./representation.ts";

const BATCH_BYTES = 4 * 1024 * 1024;
const BATCH_RECORDS = 1024;

export interface ContentPublicationReceipt {
  readonly contentId: string;
  readonly decodedLength: number;
}

export interface ContentRepositoryPublication {
  readonly resolutionScope: ContentRepositoryResolutionScope;
  publishContentFromStream(
    contentId: string,
    decodedLength: number,
    source: ContentStreamSource,
    options?: ContentPublicationOptions,
  ): Promise<ContentPublicationReceipt>;
  ensureRawContent(
    contentId: string,
    bytes: Uint8Array,
  ): Promise<ContentPublicationReceipt>;
  publishStructural(
    kind: StructuralRecordKind,
    oid: string,
    bytes: Uint8Array,
  ): Promise<void>;
  /** Make all accepted records durable before publishing snapshot metadata. */
  flush(): Promise<void>;
  revalidateContent(
    receipt: ContentPublicationReceipt,
    maximumBytes: number,
  ): Promise<void>;
  /** Settle started work and discard records that have not been flushed. */
  close(): Promise<void>;
}

export interface ContentPublicationAccess {
  readonly resolutionScope: ContentRepositoryResolutionScope;
  readonly maxDecodedBytes: number;
  recipeLimits(decodedLength: number): RecipeGraphLimits;
  reuseContent(
    contentId: string,
    decodedLength: number,
    terminal: boolean,
  ): Promise<PublishedContent | undefined>;
  reuseStructural(
    kind: StructuralRecordKind,
    oid: string,
    bytes: Uint8Array,
  ): Promise<boolean>;
  publishPack(
    input: Awaited<ReturnType<typeof encodePack>>,
  ): Promise<PublishedCatalogPack>;
  revalidateContent(
    proof: PublishedContent,
    maximumBytes: number,
    checkPack: (receipt: CatalogPackIdentityReceipt) => Promise<boolean>,
  ): Promise<void>;
  revalidatePack(receipt: CatalogPackIdentityReceipt): Promise<boolean>;
  close(): Promise<void>;
}

interface RecordReceipt {
  readonly decodedLength: number;
  existing?: PublishedContent;
  pack?: CatalogPackIdentityReceipt;
}

interface ContentReceiptState {
  readonly existing?: PublishedContent;
  readonly dependencies: ReadonlySet<RecordReceipt>;
}

interface PendingRecord {
  readonly record: RecordEnvelope;
  readonly receipt: RecordReceipt;
}

interface PendingBatch {
  readonly records: PendingRecord[];
  encodedBytes: number;
  decodedBytes: number;
}

function emptyBatch(): PendingBatch {
  return { records: [], encodedBytes: 0, decodedBytes: 0 };
}

function invalid(message: string): never {
  throw new ContentRepositoryError("invalid-input", message);
}

function integrity(message: string): never {
  throw new ContentRepositoryError("object-integrity", message);
}

/** Bounded pack writer owned by one exclusive content-publication action. */
export class ContentPackPublication implements ContentRepositoryPublication {
  readonly resolutionScope: ContentRepositoryResolutionScope;
  readonly #access: ContentPublicationAccess;
  readonly #signal: AbortSignal | undefined;
  readonly #contents = new Map<string, Promise<ContentPublicationReceipt>>();
  readonly #records = new Map<string, Promise<RecordReceipt>>();
  readonly #receipts = new WeakMap<
    ContentPublicationReceipt,
    ContentReceiptState
  >();
  readonly #chunkedRoots = new Map<
    string,
    { recipeId: string; decodedLength: number }
  >();
  readonly #packChecks = new Map<
    CatalogPackIdentityReceipt,
    Promise<boolean>
  >();
  readonly #existingChecks = new Map<PublishedContent, Promise<void>>();
  readonly #active = new Set<Promise<unknown>>();
  readonly #batches = { data: emptyBatch(), metadata: emptyBatch() };
  #tail: Promise<void> = Promise.resolve();
  #failure: { readonly cause: unknown } | undefined;
  #accepting = true;
  #flushing = false;
  #closePromise: Promise<void> | undefined;

  constructor(access: ContentPublicationAccess, signal?: AbortSignal) {
    this.#access = access;
    this.#signal = signal;
    this.resolutionScope = access.resolutionScope;
  }

  publishContentFromStream(
    contentId: string,
    decodedLength: number,
    source: ContentStreamSource,
    options: ContentPublicationOptions = {},
  ): Promise<ContentPublicationReceipt> {
    this.#assertAccepting();
    parseContentId(contentId);
    if (!Number.isSafeInteger(decodedLength) || decodedLength < 0) {
      invalid("decoded content length must be a non-negative safe integer");
    }
    if (decodedLength > this.#access.maxDecodedBytes) {
      throw new ContentRepositoryError(
        "limit-exceeded",
        "content exceeds the repository limit",
      );
    }
    const preceding = this.#contents.get(contentId);
    if (preceding !== undefined) {
      return this.#track(async () => {
        const receipt = await preceding;
        if (receipt.decodedLength !== decodedLength)
          integrity("content has conflicting lengths");
        if (options.authenticateSource === true)
          await this.#verifySource(contentId, decodedLength, source);
        return receipt;
      });
    }
    const pending = this.#track(async () => {
      const existing = await this.#access.reuseContent(
        contentId,
        decodedLength,
        false,
      );
      if (existing !== undefined) {
        if (options.authenticateSource === true)
          await this.#verifySource(contentId, decodedLength, source);
        this.#check();
        return this.#receipt(contentId, decodedLength, new Set(), existing);
      }
      const dependencies = new Set<RecordReceipt>();
      if (decodedLength < CHUNKED_CONTENT_MIN_BYTES) {
        const bytes = Buffer.allocUnsafe(decodedLength);
        let offset = 0;
        await source(async (chunk) => {
          this.#check();
          if (chunk.byteLength > decodedLength - offset)
            integrity("content source exceeded its declared length");
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        });
        if (
          offset !== decodedLength ||
          contentIdFromBytes(bytes) !== contentId
        ) {
          integrity("content source does not match its declared id and length");
        }
        dependencies.add(await this.#terminal(contentId, bytes, false));
      } else {
        const builder = new ChunkedContentPlanBuilder(
          decodedLength,
          this.#access.recipeLimits(decodedLength),
          {
            content: async (chunk) => {
              this.#check();
              dependencies.add(
                await this.#terminal(chunk.contentId, chunk.bytes, true),
              );
            },
            recipe: async (object) => {
              this.#check();
              dependencies.add(
                await this.#record(
                  `recipe:${object.recipeId}`,
                  async () => await createRecipeRecord(object.bytes),
                ),
              );
            },
          },
        );
        await source(async (chunk) => {
          this.#check();
          await builder.push(chunk);
        });
        const plan = await builder.finish();
        if (
          plan.contentId !== contentId ||
          plan.decodedLength !== decodedLength
        ) {
          integrity("content source does not match its declared id and length");
        }
        if (plan.kind === "chunked") {
          this.#chunkedRoots.set(contentId, {
            recipeId: plan.rootId,
            decodedLength,
          });
          dependencies.add(
            await this.#record(`chunked:${contentId}`, async () =>
              createChunkedContentRecord(
                parseContentId(contentId),
                decodedLength,
                plan.rootId,
              ),
            ),
          );
        }
      }
      this.#check();
      return this.#receipt(contentId, decodedLength, dependencies);
    });
    this.#contents.set(contentId, pending);
    return pending;
  }

  ensureRawContent(
    contentId: string,
    bytes: Uint8Array,
  ): Promise<ContentPublicationReceipt> {
    const owned = Uint8Array.from(bytes);
    if (contentIdFromBytes(owned) !== contentId)
      integrity("raw content does not match its declared id");
    return this.publishContentFromStream(
      contentId,
      owned.byteLength,
      async (sink) => sink(owned),
    );
  }

  publishStructural(
    kind: StructuralRecordKind,
    oid: string,
    bytes: Uint8Array,
  ): Promise<void> {
    this.#assertAccepting();
    const owned = Uint8Array.from(bytes);
    if (contentIdFromBytes(owned) !== oid)
      integrity("structural bytes do not match their declared id");
    const recordKind =
      kind === "root" ? "tree-root" : kind === "node" ? "tree-node" : "scope";
    return this.#track(async () => {
      const key = `${recordKind}:${oid}`;
      const existing = this.#records.get(key);
      if (existing !== undefined) {
        await existing;
        return;
      }
      if (await this.#access.reuseStructural(kind, oid, owned)) return;
      await this.#record(key, async () => ({
        kind: recordKind,
        logicalId: parseMetadataId(oid),
        encoding: "raw",
        decodedLength: owned.byteLength,
        payload: owned,
      }));
    });
  }

  async flush(): Promise<void> {
    this.#assertAccepting();
    this.#flushing = true;
    try {
      await Promise.all([...this.#active]);
      await this.#enqueue(async () => {
        await this.#flushBatch("data");
        await this.#flushBatch("metadata");
      });
      this.#packChecks.clear();
      this.#existingChecks.clear();
      this.#check();
    } finally {
      this.#flushing = false;
    }
  }

  revalidateContent(
    receipt: ContentPublicationReceipt,
    maximumBytes: number,
  ): Promise<void> {
    this.#assertAccepting();
    const state = this.#receipts.get(receipt);
    if (state === undefined)
      invalid("content receipt does not belong to this publication");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
      invalid("invalid content revalidation limit");
    if (receipt.decodedLength > maximumBytes) {
      throw new ContentRepositoryError(
        "limit-exceeded",
        "published content exceeds its revalidation limit",
      );
    }
    return this.#track(async () => {
      if (state.existing !== undefined)
        await this.#revalidateExisting(state.existing);
      for (const dependency of state.dependencies) {
        this.#check();
        if (dependency.existing !== undefined) {
          await this.#revalidateExisting(dependency.existing);
          continue;
        }
        const pack = dependency.pack;
        if (pack === undefined)
          invalid("content must be flushed before revalidation");
        if (!(await this.#checkPack(pack)))
          integrity("published pack changed before snapshot commit");
      }
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#accepting = false;
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#active]);
      await this.#tail.catch(() => undefined);
      this.#batches.data = emptyBatch();
      this.#batches.metadata = emptyBatch();
      this.#contents.clear();
      this.#records.clear();
      this.#chunkedRoots.clear();
      this.#packChecks.clear();
      this.#existingChecks.clear();
      await this.#access.close();
    })();
    return this.#closePromise;
  }

  #receipt(
    contentId: string,
    decodedLength: number,
    dependencies: ReadonlySet<RecordReceipt>,
    existing?: PublishedContent,
  ): ContentPublicationReceipt {
    const receipt = Object.freeze({ contentId, decodedLength });
    this.#receipts.set(
      receipt,
      existing === undefined ? { dependencies } : { dependencies, existing },
    );
    return receipt;
  }

  async #verifySource(
    contentId: string,
    decodedLength: number,
    source: ContentStreamSource,
  ): Promise<void> {
    const hash = createHash("sha256");
    let length = 0;
    await source(async (chunk) => {
      this.#check();
      if (chunk.byteLength > decodedLength - length)
        integrity("content source exceeded its declared length");
      hash.update(chunk);
      length += chunk.byteLength;
    });
    this.#check();
    if (length !== decodedLength || hash.digest("hex") !== contentId)
      integrity("content source does not match its declared id and length");
  }

  async #terminal(
    contentId: string,
    bytes: Uint8Array,
    reuse: boolean,
  ): Promise<RecordReceipt> {
    const key = `full:${contentId}`;
    const preceding = this.#records.get(key);
    if (preceding !== undefined) return await preceding;
    const pending = (async (): Promise<RecordReceipt> => {
      if (reuse) {
        const existing = await this.#access.reuseContent(
          contentId,
          bytes.byteLength,
          true,
        );
        if (existing !== undefined)
          return { decodedLength: bytes.byteLength, existing };
      }
      this.#check();
      const encoded = await encodeOwnedPayload(bytes);
      return await this.#append({
        kind: "content",
        logicalId: parseContentId(contentId),
        ...encoded,
      });
    })();
    this.#records.set(key, pending);
    return await pending;
  }

  async #record(
    key: string,
    create: () => Promise<RecordEnvelope>,
  ): Promise<RecordReceipt> {
    const preceding = this.#records.get(key);
    if (preceding !== undefined) return await preceding;
    const pending = (async () => await this.#append(await create()))();
    this.#records.set(key, pending);
    return await pending;
  }

  async #append(record: RecordEnvelope): Promise<RecordReceipt> {
    const receipt: RecordReceipt = { decodedLength: record.decodedLength };
    await this.#enqueue(async () => {
      const packClass = packClassForRecordKind(record.kind);
      const bytes = record.payload.byteLength + 128;
      const decodedBytes =
        record.encoding === "chunked-v1" ? 0 : record.decodedLength;
      let batch = this.#batches[packClass];
      if (
        batch.records.length > 0 &&
        (bytes > BATCH_BYTES - batch.encodedBytes ||
          decodedBytes > BATCH_BYTES - batch.decodedBytes ||
          batch.records.length >= BATCH_RECORDS)
      ) {
        await this.#flushBatch(packClass);
        batch = this.#batches[packClass];
      }
      batch.records.push({ record, receipt });
      batch.encodedBytes += bytes;
      batch.decodedBytes += decodedBytes;
      if (
        batch.encodedBytes >= BATCH_BYTES ||
        batch.decodedBytes >= BATCH_BYTES ||
        batch.records.length >= BATCH_RECORDS
      ) {
        await this.#flushBatch(packClass);
      }
    });
    return receipt;
  }

  async #flushBatch(packClass: PackClass): Promise<void> {
    this.#check();
    const batch = this.#batches[packClass];
    if (batch.records.length === 0) return;
    const encoded = await encodePack(
      { packClass, records: batch.records.map(({ record }) => record) },
      {
        verifyMetadataId: (_kind, oid, bytes) =>
          contentIdFromBytes(bytes) === String(oid),
        verifyChunkedContent: ({ logicalId, recipeId, decodedLength }) => {
          const expected = this.#chunkedRoots.get(logicalId);
          return (
            expected?.recipeId === recipeId &&
            expected.decodedLength === decodedLength
          );
        },
      },
    );
    this.#check();
    const published = await this.#access.publishPack(encoded);
    for (const { receipt } of batch.records)
      receipt.pack = published.identityReceipt;
    this.#batches[packClass] = emptyBatch();
    this.#check();
  }

  async #revalidateExisting(proof: PublishedContent): Promise<void> {
    let check = this.#existingChecks.get(proof);
    if (check === undefined) {
      check = this.#access.revalidateContent(
        proof,
        proof.decodedLength,
        (receipt) => this.#checkPack(receipt),
      );
      this.#existingChecks.set(proof, check);
    }
    await check;
  }

  #checkPack(receipt: CatalogPackIdentityReceipt): Promise<boolean> {
    let check = this.#packChecks.get(receipt);
    if (check === undefined) {
      check = this.#access.revalidatePack(receipt);
      this.#packChecks.set(receipt, check);
    }
    return check;
  }

  #enqueue(action: () => Promise<void>): Promise<void> {
    const pending = this.#tail.then(async () => {
      this.#check();
      await action();
    });
    this.#tail = pending;
    void pending.catch((cause: unknown) => {
      this.#failure ??= { cause };
    });
    return pending;
  }

  #track<T>(action: () => Promise<T>): Promise<T> {
    const pending = action();
    this.#active.add(pending);
    void pending.then(
      () => this.#active.delete(pending),
      (cause: unknown) => {
        this.#failure ??= { cause };
        this.#active.delete(pending);
      },
    );
    return pending;
  }

  #assertAccepting(): void {
    if (!this.#accepting || this.#flushing)
      invalid("publication is closed or flushing");
    this.#check();
  }

  #check(): void {
    if (this.#failure !== undefined) throw this.#failure.cause;
    this.#signal?.throwIfAborted();
  }
}
