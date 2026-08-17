import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMPACTION_DECODED_BYTE_BUDGET,
  DEFAULT_COMPACTION_PACK_LIMITS,
  planCompaction,
  type CompactionPackLimits,
  type ContentPathOccurrence,
  type LiveCompactionRecord,
  type LogicalRecordKey,
} from "../src/infrastructure/content-store/compaction.ts";
import {
  contentIdFromBytes,
  parseMetadataId,
  recipeIdFromCanonicalBytes,
  type ContentId,
} from "../src/infrastructure/content-store/ids.ts";
import {
  encodePack,
  measurePackInputBytes,
  type EncodePackInput,
} from "../src/infrastructure/content-store/pack.ts";
import {
  applyDelta1Program,
  decodeDelta1Program,
} from "../src/infrastructure/content-store/pack-delta.ts";
import { createChunkedContentRecord } from "../src/infrastructure/content-store/representation.ts";
import type { RecordEnvelope } from "../src/infrastructure/content-store/record.ts";

function deterministicBytes(length: number, seed: number): Uint8Array {
  const result = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < result.byteLength; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result[index] = state & 0xff;
  }
  return result;
}

function changed(
  source: Uint8Array,
  offset: number,
  replacement: readonly number[],
): Uint8Array {
  const result = Uint8Array.from(source);
  result.set(replacement, offset);
  return result;
}

function rawContent(
  bytes: Uint8Array,
): Extract<RecordEnvelope, { readonly kind: "content" }> {
  return {
    kind: "content",
    encoding: "raw",
    logicalId: contentIdFromBytes(bytes),
    decodedLength: bytes.byteLength,
    payload: Uint8Array.from(bytes),
  };
}

function keyFor(record: RecordEnvelope): LogicalRecordKey {
  switch (record.kind) {
    case "content":
      return { kind: record.kind, logicalId: record.logicalId };
    case "recipe":
      return { kind: record.kind, logicalId: record.logicalId };
    case "tree-root":
    case "tree-node":
    case "scope":
      return { kind: record.kind, logicalId: record.logicalId };
  }
}

function live(
  record: RecordEnvelope,
  dependencies: readonly LogicalRecordKey[] = [],
): LiveCompactionRecord {
  return { ...keyFor(record), dependencies } as LiveCompactionRecord;
}

function recordKey(key: LogicalRecordKey): string {
  return `${key.kind}:${key.logicalId}`;
}

async function makePlan(input: {
  readonly envelopes: readonly RecordEnvelope[];
  readonly decoded?: ReadonlyMap<ContentId, Uint8Array>;
  readonly occurrences?: readonly ContentPathOccurrence[];
  readonly dependencies?: ReadonlyMap<string, readonly LogicalRecordKey[]>;
  readonly limits?: CompactionPackLimits;
}) {
  const byKey = new Map(
    input.envelopes.map((envelope) => [recordKey(keyFor(envelope)), envelope]),
  );
  const decoded =
    input.decoded ??
    new Map(
      input.envelopes.flatMap((envelope) =>
        envelope.kind === "content" && envelope.encoding === "raw"
          ? [[envelope.logicalId, envelope.payload] as const]
          : [],
      ),
    );
  return await planCompaction({
    records: input.envelopes.map((envelope) =>
      live(
        envelope,
        input.dependencies?.get(recordKey(keyFor(envelope))) ?? [],
      ),
    ),
    contentPathOccurrences: input.occurrences ?? [],
    read: {
      readEnvelope: async (key) => {
        const envelope = byKey.get(recordKey(key));
        if (envelope === undefined) {
          throw new Error(`missing test envelope ${recordKey(key)}`);
        }
        return {
          ...envelope,
          payload: Uint8Array.from(envelope.payload),
        } as RecordEnvelope;
      },
      readDecodedContent: async (contentId) => {
        const bytes = decoded.get(contentId);
        if (bytes === undefined) {
          throw new Error(`missing test content ${contentId}`);
        }
        return Uint8Array.from(bytes);
      },
    },
    ...(input.limits === undefined ? {} : { packLimits: input.limits }),
  });
}

function repeatOccurrence(
  canonicalPath: string,
  contentId: ContentId,
  count: number,
): ContentPathOccurrence[] {
  return Array.from({ length: count }, () => ({ canonicalPath, contentId }));
}

function allRecords(batches: readonly EncodePackInput[]): RecordEnvelope[] {
  return batches.flatMap((batch) => [...batch.records]);
}

describe("content-store compaction planning", () => {
  it("packs repeated small-file history as one-hop deltas from an earlier full anchor", async () => {
    const baseBytes = deterministicBytes(16 * 1024, 0x1020_3040);
    const firstBytes = changed(baseBytes, 4_000, [1, 2, 3, 4, 5, 6, 7, 8]);
    const secondBytes = changed(baseBytes, 12_000, [8, 7, 6, 5, 4, 3, 2, 1]);
    const base = rawContent(baseBytes);
    const first = rawContent(firstBytes);
    const second = rawContent(secondBytes);
    const decoded = new Map<ContentId, Uint8Array>([
      [base.logicalId, baseBytes],
      [first.logicalId, firstBytes],
      [second.logicalId, secondBytes],
    ]);
    const plan = await makePlan({
      envelopes: [second, base, first],
      decoded,
      limits: {
        ...DEFAULT_COMPACTION_PACK_LIMITS,
        maxRecordsPerPack: 2,
      },
      occurrences: [
        ...repeatOccurrence("src/value.ts", base.logicalId, 5),
        ...repeatOccurrence("src/value.ts", first.logicalId, 1),
        ...repeatOccurrence("src/value.ts", second.logicalId, 1),
      ],
    });

    expect(plan.physicalDependencies).toHaveLength(2);
    expect(
      plan.physicalDependencies.map(({ baseContentId }) => baseContentId),
    ).toEqual([base.logicalId, base.logicalId]);
    for (const dependency of plan.physicalDependencies) {
      const batch = plan.batches[dependency.batchIndex];
      expect(batch?.packClass).toBe("data");
      expect(batch?.records).toHaveLength(2);
      const targetOrdinal = batch?.records.findIndex(
        (record) => record.logicalId === dependency.targetContentId,
      );
      expect(targetOrdinal).toBeGreaterThan(0);
      const target = batch?.records[targetOrdinal!];
      expect(target?.encoding).toBe("delta1");
      if (
        target === undefined ||
        target.kind !== "content" ||
        target.encoding !== "delta1" ||
        batch === undefined
      ) {
        throw new Error("test delta was not planned");
      }
      const program = decodeDelta1Program(target.payload, target.decodedLength);
      const baseOrdinal = targetOrdinal! - program.baseBackDistance;
      const physicalBase = batch.records[baseOrdinal];
      expect(physicalBase?.logicalId).toBe(base.logicalId);
      expect(["raw", "zstd-v1"]).toContain(physicalBase?.encoding);
      expect(
        applyDelta1Program(program, baseBytes, target.decodedLength),
      ).toEqual(decoded.get(target.logicalId));
    }
    for (const batch of plan.batches) {
      const encoded = await encodePack(batch);
      expect(encoded.bytes.byteLength).toBe(measurePackInputBytes(batch));
    }
  });

  it("keeps unrelated small contents full when delta has no measured benefit", async () => {
    const frequent = rawContent(deterministicBytes(8 * 1024, 1));
    const unrelated = rawContent(deterministicBytes(8 * 1024, 2));
    const plan = await makePlan({
      envelopes: [frequent, unrelated],
      occurrences: [
        ...repeatOccurrence("src/random.bin", frequent.logicalId, 3),
        ...repeatOccurrence("src/random.bin", unrelated.logicalId, 1),
      ],
    });

    expect(plan.physicalDependencies).toEqual([]);
    expect(
      allRecords(plan.batches).map(({ encoding }) => encoding),
    ).not.toContain("delta1");
  });

  it("uses one-hop deltas across the complete 256 KiB full-record domain", async () => {
    const baseBytes = deterministicBytes(192 * 1024, 0x2560_0001);
    const targetBytes = changed(baseBytes, 96 * 1024, [1, 3, 3, 7]);
    const base = rawContent(baseBytes);
    const target = rawContent(targetBytes);
    const plan = await makePlan({
      envelopes: [target, base],
      occurrences: [
        ...repeatOccurrence("src/large-source.ts", base.logicalId, 3),
        ...repeatOccurrence("src/large-source.ts", target.logicalId, 1),
      ],
    });
    const delta = allRecords(plan.batches).find(
      (record) => record.logicalId === target.logicalId,
    );

    expect(delta?.encoding).toBe("delta1");
    if (delta?.encoding !== "delta1") {
      throw new Error("large full-record target did not use delta1");
    }
    const program = decodeDelta1Program(delta.payload, delta.decodedLength);
    expect(applyDelta1Program(program, baseBytes, delta.decodedLength)).toEqual(
      targetBytes,
    );
  });

  it("keeps an unprofitable 256 KiB ADD full without overflowing the delta payload", async () => {
    const frequent = rawContent(deterministicBytes(256 * 1024, 0x1111_1111));
    const unrelated = rawContent(deterministicBytes(256 * 1024, 0xeeee_eeee));

    const plan = await makePlan({
      envelopes: [frequent, unrelated],
      occurrences: [
        ...repeatOccurrence("src/generated.ts", frequent.logicalId, 3),
        ...repeatOccurrence("src/generated.ts", unrelated.logicalId, 1),
      ],
    });

    expect(plan.physicalDependencies).toEqual([]);
    expect(
      allRecords(plan.batches).map(({ encoding }) => encoding),
    ).not.toContain("delta1");
  });

  it("preserves authenticated large and recipe envelopes without decoding content", async () => {
    const decodedLarge = deterministicBytes(300 * 1024, 0x55aa);
    const recipeBytes = Buffer.from("authenticated chunk recipe", "utf8");
    const recipe: RecordEnvelope = {
      kind: "recipe",
      encoding: "raw",
      logicalId: recipeIdFromCanonicalBytes(recipeBytes),
      decodedLength: recipeBytes.byteLength,
      payload: recipeBytes,
    };
    const large: RecordEnvelope = {
      kind: "content",
      encoding: "chunked-v1",
      logicalId: contentIdFromBytes(decodedLarge),
      decodedLength: decodedLarge.byteLength,
      payload: Buffer.from(recipe.logicalId, "hex"),
    };
    const dependencies = new Map<string, readonly LogicalRecordKey[]>([
      [recordKey(keyFor(large)), [keyFor(recipe)]],
    ]);
    const plan = await makePlan({
      envelopes: [large, recipe],
      dependencies,
      occurrences: [
        { canonicalPath: "assets/large.bin", contentId: large.logicalId },
      ],
    });
    const planned = allRecords(plan.batches).find(
      (record) => record.logicalId === large.logicalId,
    );

    expect(
      planned === undefined
        ? undefined
        : { ...planned, payload: Buffer.from(planned.payload) },
    ).toEqual({ ...large, payload: Buffer.from(large.payload) });
    const dataBatch = plan.batches.find(
      ({ packClass }) => packClass === "data",
    );
    if (dataBatch === undefined) {
      throw new Error("large content data batch was not planned");
    }
    await expect(
      encodePack(dataBatch, { verifyChunkedContent: () => true }),
    ).resolves.toBeDefined();
  });

  it("is independent of live-record and history-enumeration order", async () => {
    const base = rawContent(deterministicBytes(12 * 1024, 3));
    const next = rawContent(changed(base.payload, 6_000, [4, 5, 6, 7]));
    const envelopes = [base, next];
    const occurrences = [
      ...repeatOccurrence("src/stable.ts", base.logicalId, 2),
      ...repeatOccurrence("src/stable.ts", next.logicalId, 1),
    ];

    const forward = await makePlan({ envelopes, occurrences });
    const reverse = await makePlan({
      envelopes: [...envelopes].reverse(),
      occurrences: [...occurrences].reverse(),
    });

    expect(reverse).toEqual(forward);
  });

  it("uses deterministic bounded pack boundaries below the soft target", async () => {
    const envelopes = Array.from({ length: 5 }, (_, index) =>
      rawContent(deterministicBytes(3 * 1024, 100 + index)),
    );
    const limits: CompactionPackLimits = {
      dataTargetBytes: 10_000,
      dataHardMaxBytes: 12_000,
      metadataTargetBytes: 10_000,
      metadataMultiRecordHardMaxBytes: 12_000,
      metadataSingletonHardMaxBytes: 12_000,
      maxRecordsPerPack: 100,
    };
    const plan = await makePlan({ envelopes, limits });
    const dataBatches = plan.batches.filter(
      ({ packClass }) => packClass === "data",
    );

    expect(dataBatches.map(({ records }) => records.length)).toEqual([3, 2]);
    expect(
      dataBatches.every((batch) => measurePackInputBytes(batch) <= 10_000),
    ).toBe(true);
  });

  it("allows only a legal oversized singleton and retains logical dependencies", async () => {
    const content = rawContent(deterministicBytes(128, 9));
    const recipeBytes = deterministicBytes(5_000, 10);
    const recipe: RecordEnvelope = {
      kind: "recipe",
      encoding: "raw",
      logicalId: recipeIdFromCanonicalBytes(recipeBytes),
      decodedLength: recipeBytes.byteLength,
      payload: recipeBytes,
    };
    const rootBytes = Uint8Array.of(1);
    const root: RecordEnvelope = {
      kind: "tree-root",
      encoding: "raw",
      logicalId: parseMetadataId("ab".repeat(32)),
      decodedLength: rootBytes.byteLength,
      payload: rootBytes,
    };
    const dependencies = new Map<string, readonly LogicalRecordKey[]>([
      [recordKey(keyFor(recipe)), [keyFor(content)]],
      [recordKey(keyFor(root)), [keyFor(recipe)]],
    ]);
    const limits: CompactionPackLimits = {
      dataTargetBytes: 1_000,
      dataHardMaxBytes: 6_000,
      metadataTargetBytes: 1_000,
      metadataMultiRecordHardMaxBytes: 6_000,
      metadataSingletonHardMaxBytes: 6_000,
      maxRecordsPerPack: 100,
    };
    const plan = await makePlan({
      envelopes: [root, content, recipe],
      dependencies,
      limits,
    });
    const recipeBatchIndex = plan.batches.findIndex((batch) =>
      batch.records.some((record) => record.logicalId === recipe.logicalId),
    );
    const recipeBatch = plan.batches[recipeBatchIndex];

    expect(recipeBatch?.records).toHaveLength(1);
    expect(measurePackInputBytes(recipeBatch!)).toBeGreaterThan(
      limits.metadataTargetBytes,
    );
    expect(measurePackInputBytes(recipeBatch!)).toBeLessThanOrEqual(
      limits.metadataSingletonHardMaxBytes,
    );
    expect(plan.logicalDependencies).toContainEqual({
      source: keyFor(recipe),
      dependencies: [keyFor(content)],
    });
    expect(plan.logicalDependencies).toContainEqual({
      source: keyFor(root),
      dependencies: [keyFor(recipe)],
    });
    const encoded = await encodePack(recipeBatch!, {
      verifyMetadataId: () => true,
    });
    expect(encoded.bytes.byteLength).toBe(measurePackInputBytes(recipeBatch!));
  });

  it("rejects one logical record above the decoded maintenance budget", async () => {
    const contentId = contentIdFromBytes(Buffer.from("oversized root", "utf8"));
    const recipeId = recipeIdFromCanonicalBytes(
      Buffer.from("oversized recipe", "utf8"),
    );
    const root = createChunkedContentRecord(
      contentId,
      DEFAULT_COMPACTION_DECODED_BYTE_BUDGET + 1,
      recipeId,
    );
    await expect(makePlan({ envelopes: [root] })).rejects.toMatchObject({
      code: "limit-exceeded",
    });
  });

  it("bounds aggregate decoded bytes independently of pack byte limits", async () => {
    const decodedLength = 20 * 1024 * 1024;
    const roots = ["first", "second"].map((name) =>
      createChunkedContentRecord(
        contentIdFromBytes(Buffer.from(`budget ${name}`, "utf8")),
        decodedLength,
        recipeIdFromCanonicalBytes(
          Buffer.from(`budget recipe ${name}`, "utf8"),
        ),
      ),
    );
    await expect(makePlan({ envelopes: roots })).rejects.toMatchObject({
      code: "limit-exceeded",
    });
  });
});
