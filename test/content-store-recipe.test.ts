import { describe, expect, it } from "vitest";

import {
  CHUNKED_CONTENT_MIN_BYTES,
  MAX_RECIPE_OBJECT_BYTES,
  ChunkedContentPlanBuilder,
  buildChunkRecipePlan,
  decodeRecipeNode,
  decodeRecipeRoot,
  describeChunkedContent,
  encodeRecipeNode,
  encodeRecipeRoot,
  authenticateChunkRecipeGraph,
  type ContentChunkReference,
  type RecipeGraphLimits,
} from "../src/infrastructure/content-store/chunk-recipe.ts";
import { FASTCDC_V1_PROFILE } from "../src/infrastructure/content-store/fastcdc.ts";
import {
  contentIdFromBytes,
  parseContentId,
  recipeIdFromCanonicalBytes,
} from "../src/infrastructure/content-store/ids.ts";

const LIMITS: RecipeGraphLimits = {
  maxChunks: 10_000,
  maxDecodedBytes: 256 * 1024 * 1024,
  maxDepth: 8,
  maxNodes: 1_000,
};

function deterministicBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x1234_5678;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

describe("bounded chunk recipe DAG", () => {
  it("requires a candidate above 64 KiB to produce at least two chunks", () => {
    expect(CHUNKED_CONTENT_MIN_BYTES).toBe(64 * 1024 + 1);
    expect(() =>
      describeChunkedContent(
        new Uint8Array(CHUNKED_CONTENT_MIN_BYTES - 1),
        LIMITS,
      ),
    ).toThrow(RangeError);
    expect(() =>
      describeChunkedContent(new Uint8Array(96 * 1024), LIMITS),
    ).toThrow(/one FastCDC chunk/u);
    const multiChunk = deterministicBytes(100 * 1024);
    expect(describeChunkedContent(multiChunk, LIMITS).root.chunkCount).toBe(2);
  });

  it("rejects a canonical recipe root that merely wraps one chunk", () => {
    const bytes = new Uint8Array(96 * 1024);
    const chunk = Object.freeze({
      kind: "content" as const,
      contentId: contentIdFromBytes(bytes),
      decodedLength: bytes.byteLength,
    });
    expect(() =>
      buildChunkRecipePlan(
        chunk.contentId,
        bytes.byteLength,
        Object.freeze([chunk]),
        LIMITS,
      ),
    ).toThrow(/at least two/u);
  });

  it("builds canonical, authenticated objects in children-before-parent order", () => {
    const input = deterministicBytes(1024 * 1024);
    const plan = describeChunkedContent(input, LIMITS);
    expect(plan.root.contentId).toBe(contentIdFromBytes(input));
    expect(plan.root.chunkCount).toBe(plan.chunks.length);
    expect(plan.objects.at(-1)?.recipeId).toBe(plan.rootId);
    expect(plan.objects.at(-1)?.value.kind).toBe("root");

    for (const object of plan.objects) {
      expect(object.bytes.byteLength).toBeLessThanOrEqual(
        MAX_RECIPE_OBJECT_BYTES,
      );
      if (object.value.kind === "root") {
        expect(decodeRecipeRoot(object.bytes, LIMITS)).toEqual(object.value);
        expect(encodeRecipeRoot(object.value)).toEqual(object.bytes);
      } else {
        expect(decodeRecipeNode(object.bytes, LIMITS)).toEqual(object.value);
        expect(encodeRecipeNode(object.value)).toEqual(object.bytes);
      }
    }
  });

  it("splits large reference sets so every canonical node stays below 32 KiB", () => {
    const chunkId = parseContentId("ab".repeat(32));
    const chunks: ContentChunkReference[] = Array.from(
      { length: 1_000 },
      () => ({
        kind: "content",
        contentId: chunkId,
        decodedLength: FASTCDC_V1_PROFILE.minimumBytes,
      }),
    );
    const decodedLength = chunks.length * FASTCDC_V1_PROFILE.minimumBytes;
    const plan = buildChunkRecipePlan(
      parseContentId("cd".repeat(32)),
      decodedLength,
      chunks,
      LIMITS,
    );

    expect(plan.root.chunkCount).toBe(1_000);
    expect(plan.root.nodeCount).toBe(4); // root + branch + two leaves
    expect(plan.objects).toHaveLength(4);
    expect(
      Math.max(...plan.objects.map((object) => object.bytes.byteLength)),
    ).toBeLessThanOrEqual(MAX_RECIPE_OBJECT_BYTES);
  });

  it("authenticates and flattens the complete bounded graph", async () => {
    const input = deterministicBytes(2 * 1024 * 1024);
    const plan = describeChunkedContent(input, LIMITS);
    const objects = new Map(
      plan.objects.map((object) => [object.recipeId, object.bytes] as const),
    );
    const verified = await authenticateChunkRecipeGraph(
      plan.rootId,
      {
        contentId: plan.root.contentId,
        decodedLength: plan.root.decodedLength,
      },
      async (recipeId) => {
        const bytes = objects.get(recipeId);
        if (bytes === undefined) {
          throw new Error(`missing recipe ${recipeId}`);
        }
        return bytes;
      },
      LIMITS,
    );

    expect(verified.contentId).toBe(contentIdFromBytes(input));
    expect(verified.decodedLength).toBe(input.byteLength);
    expect(verified.chunks).toHaveLength(plan.root.chunkCount);
    expect(verified.chunks.every((chunk) => chunk.kind === "content")).toBe(
      true,
    );
    expect(
      verified.chunks.reduce((total, chunk) => total + chunk.decodedLength, 0),
    ).toBe(input.byteLength);
  });

  it("flattens a legal wide recipe without variadic array expansion", async () => {
    const chunkLength = FASTCDC_V1_PROFILE.minimumBytes;
    const chunk = Object.freeze({
      kind: "content" as const,
      contentId: parseContentId("ab".repeat(32)),
      decodedLength: chunkLength,
    });
    const leafChunks = Array.from({ length: 768 }, () => chunk);
    const leaf = Object.freeze({
      kind: "leaf" as const,
      decodedLength: leafChunks.length * chunkLength,
      depth: 1 as const,
      nodeCount: 1,
      chunkCount: leafChunks.length,
      chunks: Object.freeze(leafChunks),
    });
    const leafBytes = encodeRecipeNode(leaf);
    const leafId = recipeIdFromCanonicalBytes(leafBytes);
    const leafReference = Object.freeze({
      kind: "recipe" as const,
      recipeId: leafId,
      decodedLength: leaf.decodedLength,
      depth: leaf.depth,
      nodeCount: leaf.nodeCount,
      chunkCount: leaf.chunkCount,
    });
    const branchChildren = Array.from({ length: 480 }, () => leafReference);
    const branch = Object.freeze({
      kind: "branch" as const,
      decodedLength: leaf.decodedLength * branchChildren.length,
      depth: 2,
      nodeCount: 1 + leaf.nodeCount * branchChildren.length,
      chunkCount: leaf.chunkCount * branchChildren.length,
      children: Object.freeze(branchChildren),
    });
    const branchBytes = encodeRecipeNode(branch);
    const branchId = recipeIdFromCanonicalBytes(branchBytes);
    const branchReference = Object.freeze({
      kind: "recipe" as const,
      recipeId: branchId,
      decodedLength: branch.decodedLength,
      depth: branch.depth,
      nodeCount: branch.nodeCount,
      chunkCount: branch.chunkCount,
    });
    const contentId = parseContentId("cd".repeat(32));
    const root = Object.freeze({
      kind: "root" as const,
      profile: FASTCDC_V1_PROFILE.id,
      contentId,
      decodedLength: branch.decodedLength,
      depth: branch.depth + 1,
      nodeCount: branch.nodeCount + 1,
      chunkCount: branch.chunkCount,
      child: branchReference,
    });
    const rootBytes = encodeRecipeRoot(root);
    const rootId = recipeIdFromCanonicalBytes(rootBytes);
    const objects = new Map([
      [leafId, leafBytes],
      [branchId, branchBytes],
      [rootId, rootBytes],
    ]);
    const limits: RecipeGraphLimits = {
      maxChunks: branch.chunkCount,
      maxDecodedBytes: branch.decodedLength,
      maxDepth: root.depth,
      maxNodes: root.nodeCount,
    };

    const verified = await authenticateChunkRecipeGraph(
      rootId,
      { contentId, decodedLength: root.decodedLength },
      async (recipeId) => objects.get(recipeId) ?? new Uint8Array(),
      limits,
    );
    expect(verified.decodedLength).toBe(branch.decodedLength);
    expect(verified.chunks).toHaveLength(branch.chunkCount);
  });

  it("enforces root identity and decoded-byte, depth, node, and chunk limits", async () => {
    const input = deterministicBytes(1024 * 1024);
    const plan = describeChunkedContent(input, LIMITS);
    const rootBytes = plan.objects.at(-1)?.bytes;
    expect(rootBytes).toBeDefined();
    if (rootBytes === undefined) {
      throw new Error("missing root bytes");
    }

    const constrained = [
      { ...LIMITS, maxDecodedBytes: input.byteLength - 1 },
      { ...LIMITS, maxDepth: plan.root.depth - 1 },
      { ...LIMITS, maxNodes: plan.root.nodeCount - 1 },
      { ...LIMITS, maxChunks: plan.root.chunkCount - 1 },
    ];
    for (const limits of constrained) {
      expect(() => decodeRecipeRoot(rootBytes, limits)).toThrowError(
        expect.objectContaining({ code: "limit-exceeded" }),
      );
    }

    const objects = new Map(
      plan.objects.map((object) => [object.recipeId, object.bytes] as const),
    );
    await expect(
      authenticateChunkRecipeGraph(
        plan.rootId,
        {
          contentId: parseContentId("00".repeat(32)),
          decodedLength: plan.root.decodedLength,
        },
        async (recipeId) => objects.get(recipeId) ?? new Uint8Array(),
        LIMITS,
      ),
    ).rejects.toMatchObject({ code: "unexpected-value" });
    await expect(
      authenticateChunkRecipeGraph(
        plan.rootId,
        {
          contentId: plan.root.contentId,
          decodedLength: plan.root.decodedLength + 1,
        },
        async (recipeId) => objects.get(recipeId) ?? new Uint8Array(),
        LIMITS,
      ),
    ).rejects.toMatchObject({ code: "unexpected-value" });
    await expect(
      authenticateChunkRecipeGraph(
        plan.rootId,
        {
          contentId: plan.root.contentId,
          decodedLength: plan.root.decodedLength,
        },
        async (recipeId) => {
          const bytes = objects.get(recipeId) ?? new Uint8Array();
          return recipeId === plan.rootId
            ? Buffer.concat([bytes, Uint8Array.of(0)])
            : bytes;
        },
        LIMITS,
      ),
    ).rejects.toMatchObject({ code: "unexpected-value" });
  });
});

describe("streaming chunk representation plan", () => {
  it("matches the whole-buffer golden plan with bounded chunk callbacks", async () => {
    const input = deterministicBytes(3 * 1024 * 1024);
    const expected = describeChunkedContent(input, LIMITS);
    const candidates: {
      readonly contentId: string;
      readonly length: number;
      readonly bytes: Uint8Array;
    }[] = [];
    const recipeObjects: {
      readonly recipeId: string;
      readonly value: { readonly kind: string };
      readonly bytes: Uint8Array;
    }[] = [];
    const publishedContent = new Set<string>();
    const publishedRecipes = new Set<string>();
    const builder = new ChunkedContentPlanBuilder(input.byteLength, LIMITS, {
      content: async (candidate) => {
        expect(candidate.length).toBeLessThanOrEqual(
          FASTCDC_V1_PROFILE.maximumBytes,
        );
        expect(candidate.contentId).toBe(contentIdFromBytes(candidate.bytes));
        candidates.push(candidate);
        publishedContent.add(candidate.contentId);
      },
      recipe: async (object) => {
        if (object.value.kind === "leaf") {
          expect(
            object.value.chunks.every((chunk) =>
              publishedContent.has(chunk.contentId),
            ),
          ).toBe(true);
        } else if (object.value.kind === "branch") {
          expect(
            object.value.children.every((child) =>
              publishedRecipes.has(child.recipeId),
            ),
          ).toBe(true);
        } else {
          expect(publishedRecipes.has(object.value.child.recipeId)).toBe(true);
        }
        recipeObjects.push(object);
        publishedRecipes.add(object.recipeId);
      },
    });

    const pushSizes = [1, 8_191, 65_537, 17, 262_144, 32_769];
    let offset = 0;
    let pushIndex = 0;
    while (offset < input.byteLength) {
      const requested = pushSizes[pushIndex % pushSizes.length] ?? 1;
      const length = Math.min(requested, input.byteLength - offset);
      await builder.push(input.subarray(offset, offset + length));
      offset += length;
      pushIndex += 1;
    }
    const observed = await builder.finish();

    expect(observed.kind).toBe("chunked");
    if (observed.kind !== "chunked") {
      throw new Error("multi-chunk input unexpectedly used a full result");
    }
    expect(observed.rootId).toBe(expected.rootId);
    expect(recipeObjects.map((object) => object.bytes)).toEqual(
      expected.objects.map((object) => object.bytes),
    );
    expect(
      Buffer.concat(candidates.map((candidate) => candidate.bytes)),
    ).toEqual(Buffer.from(input));
  });

  it("requires the exact observed length and settles after failure", async () => {
    const builder = new ChunkedContentPlanBuilder(
      CHUNKED_CONTENT_MIN_BYTES,
      LIMITS,
      { content: () => undefined, recipe: () => undefined },
    );
    await builder.push(new Uint8Array(CHUNKED_CONTENT_MIN_BYTES - 1));
    await expect(builder.finish()).rejects.toThrow(/expected/u);
    await expect(builder.push(Uint8Array.of(0))).rejects.toThrow(/settled/u);
  });

  it("returns one FastCDC chunk as full without publishing recipe objects", async () => {
    const input = new Uint8Array(96 * 1024);
    const contents: { readonly contentId: string; readonly length: number }[] =
      [];
    const recipes: Uint8Array[] = [];
    const builder = new ChunkedContentPlanBuilder(input.byteLength, LIMITS, {
      content: (chunk) => {
        contents.push(chunk);
      },
      recipe: (object) => {
        recipes.push(object.bytes);
      },
    });

    await builder.push(input.subarray(0, 17 * 1024));
    await builder.push(input.subarray(17 * 1024));
    const result = await builder.finish();

    expect(result).toEqual({
      kind: "full",
      contentId: contentIdFromBytes(input),
      decodedLength: input.byteLength,
      chunk: {
        kind: "content",
        contentId: contentIdFromBytes(input),
        decodedLength: input.byteLength,
      },
    });
    expect(contents).toHaveLength(1);
    expect(recipes).toEqual([]);
  });

  it("flushes full leaf accumulators before EOF without retaining all refs", async () => {
    const expectedLength = 56 * 1024 * 1024;
    const recipeObjects: Parameters<
      NonNullable<
        ConstructorParameters<typeof ChunkedContentPlanBuilder>[2]["recipe"]
      >
    >[0][] = [];
    let contentCount = 0;
    const builder = new ChunkedContentPlanBuilder(expectedLength, LIMITS, {
      content: () => {
        contentCount += 1;
      },
      recipe: (object) => {
        recipeObjects.push(object);
      },
    });

    let state = 0x1357_9bdf;
    for (let remaining = expectedLength; remaining > 0;) {
      const length = Math.min(1024 * 1024, remaining);
      const block = new Uint8Array(length);
      for (let index = 0; index < block.byteLength; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        block[index] = state >>> 24;
      }
      await builder.push(block);
      remaining -= length;
    }
    const result = await builder.finish();

    expect(result.kind).toBe("chunked");
    if (result.kind !== "chunked") {
      throw new Error("wide input unexpectedly used a full result");
    }
    expect(contentCount).toBeGreaterThan(768);
    expect(result.root.chunkCount).toBe(contentCount);
    expect(
      recipeObjects.filter((object) => object.value.kind === "leaf"),
    ).toHaveLength(2);
    expect(
      recipeObjects.filter((object) => object.value.kind === "branch"),
    ).toHaveLength(1);
    expect(recipeObjects.at(-1)?.value.kind).toBe("root");

    const stored = new Map(
      recipeObjects.map((object) => [object.recipeId, object.bytes] as const),
    );
    await expect(
      authenticateChunkRecipeGraph(
        result.rootId,
        {
          contentId: result.contentId,
          decodedLength: expectedLength,
        },
        async (recipeId) => stored.get(recipeId) ?? new Uint8Array(),
        LIMITS,
      ),
    ).resolves.toMatchObject({
      contentId: result.contentId,
      decodedLength: expectedLength,
    });
  });
});
