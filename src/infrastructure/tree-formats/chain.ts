import { TextDecoder } from "node:util";

import type { WorkspacePathLimits } from "../workspace-scope.ts";
import {
  ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
  ABSOLUTE_TREE_MANIFEST_LIMITS,
  freezeTreeManifest,
  TreeManifestError,
  type TreeManifest,
  type TreeManifestLimits,
} from "./manifest-codec.ts";

/**
 * One node in the on-disk format history. A node knows only its immediate
 * predecessor, so adding a format never requires editing an old-format table.
 */
export interface TreeFormatNode<Format extends string = string> {
  readonly format: Format;
  readonly previous?: TreeFormatNode;
  /** Construct canonical semantics for this format node. */
  readonly create: (
    entries: unknown,
    scope: unknown,
    limits: TreeManifestLimits,
  ) => TreeManifest;
  /**
   * Inline formats authenticate one self-contained object synchronously.
   * Graph formats omit both codecs and are read through a
   * StoredTreeFormatAdapter instead.
   */
  readonly decode?: (
    candidate: Readonly<Record<string, unknown>>,
    limits: TreeManifestLimits,
  ) => TreeManifest;
  readonly encode?: (
    manifest: TreeManifest,
    limits: TreeManifestLimits,
  ) => Buffer;
  readonly upgradeFromPrevious?: (
    previous: TreeManifest,
    pathLimits: WorkspacePathLimits,
  ) => TreeManifest;
  readonly referencedBlobOids: (manifest: TreeManifest) => readonly string[];
}

export interface TreeFormatEngine {
  readonly current: TreeFormatNode;
  parse(content: Uint8Array): TreeManifest;
  upgradeTo(
    manifest: TreeManifest,
    targetFormat: string,
    pathLimits: WorkspacePathLimits,
  ): TreeManifest;
  referencedBlobOids(manifest: TreeManifest): readonly string[];
}

/** Authenticate and expose one immutable oldest-to-current format history. */
export function treeFormatChain(
  current: TreeFormatNode,
): readonly TreeFormatNode[] {
  const newestFirst: TreeFormatNode[] = [];
  const byFormat = new Map<string, TreeFormatNode>();
  const seen = new Set<TreeFormatNode>();
  let cursor: TreeFormatNode | undefined = current;
  while (cursor !== undefined) {
    if (seen.has(cursor)) {
      throw new Error("tree format history contains a cycle");
    }
    if (cursor.format.length === 0 || byFormat.has(cursor.format)) {
      throw new Error("tree format history contains an invalid format id");
    }
    if (
      cursor.previous !== undefined &&
      cursor.upgradeFromPrevious === undefined
    ) {
      throw new Error(
        `tree format ${cursor.format} omits its adjacent upgrade`,
      );
    }
    if (
      cursor.previous === undefined &&
      cursor.upgradeFromPrevious !== undefined
    ) {
      throw new Error("first tree format cannot have an adjacent upgrade");
    }
    if ((cursor.decode === undefined) !== (cursor.encode === undefined)) {
      throw new Error(
        `tree format ${cursor.format} must define both inline codecs or neither`,
      );
    }
    seen.add(cursor);
    newestFirst.push(cursor);
    byFormat.set(cursor.format, cursor);
    cursor = cursor.previous;
  }
  // The lookup and metadata tree-format marker must describe the same history
  // for the engine's whole lifetime. Freeze caller-defined successor nodes as
  // part of construction instead of relying on TypeScript's erased readonly.
  for (const node of newestFirst) Object.freeze(node);
  return Object.freeze(newestFirst.reverse());
}

/** Build parser lookup solely from the authenticated adjacent format chain. */
export function createTreeFormatEngine(
  current: TreeFormatNode,
): TreeFormatEngine {
  const oldestFirst = treeFormatChain(current);
  const newestFirst = [...oldestFirst].reverse();
  const byFormat = new Map(
    oldestFirst.map((node) => [node.format, node] as const),
  );

  const nodeFor = (manifest: TreeManifest): TreeFormatNode => {
    const node = byFormat.get(manifest.format);
    if (node === undefined) {
      throw new TreeManifestError(
        "invalid-tree-manifest",
        "tree manifest format is outside the supported history",
      );
    }
    return node;
  };

  const upgradeTo = (
    manifest: TreeManifest,
    targetFormat: string,
    pathLimits: WorkspacePathLimits,
  ): TreeManifest => {
    const source = nodeFor(manifest);
    const target = byFormat.get(targetFormat);
    if (target === undefined) {
      throw new TreeManifestError(
        "format-incompatible",
        `target tree format ${JSON.stringify(targetFormat)} is outside the supported history`,
      );
    }
    if (source === target) return freezeTreeManifest(manifest);

    const sourceIndex = newestFirst.indexOf(source);
    const targetIndex = newestFirst.indexOf(target);
    if (targetIndex > sourceIndex) {
      throw new TreeManifestError(
        "format-incompatible",
        `tree format ${source.format} cannot be downgraded to ${target.format}`,
      );
    }

    let upgraded = manifest;
    for (let index = sourceIndex - 1; index >= targetIndex; index -= 1) {
      const node = newestFirst[index]!;
      const upgrade = node.upgradeFromPrevious;
      if (upgrade === undefined) {
        throw new Error(`tree format ${node.format} has no adjacent upgrade`);
      }
      const candidate = upgrade(upgraded, pathLimits);
      if (candidate.format !== node.format) {
        throw new Error(
          `tree format ${node.format} adjacent upgrade returned ${candidate.format}`,
        );
      }
      upgraded = candidate;
    }
    return freezeTreeManifest(upgraded);
  };

  return Object.freeze<TreeFormatEngine>({
    current,
    parse(content) {
      if (content.byteLength > ABSOLUTE_MAX_TREE_MANIFEST_BYTES) {
        throw new TreeManifestError(
          "object-integrity",
          `tree object exceeds the ${ABSOLUTE_MAX_TREE_MANIFEST_BYTES}-byte parser limit`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(content),
        );
      } catch (error) {
        throw new TreeManifestError(
          "object-integrity",
          "tree object is not valid UTF-8 JSON",
          error,
        );
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new TreeManifestError(
          "object-integrity",
          "tree object has an invalid manifest shape",
        );
      }
      const candidate = parsed as Record<string, unknown>;
      const node =
        typeof candidate.format === "string"
          ? byFormat.get(candidate.format)
          : undefined;
      if (node === undefined) {
        throw new TreeManifestError(
          "object-integrity",
          "tree object has an unsupported manifest format",
        );
      }

      let manifest: TreeManifest;
      try {
        if (node.decode === undefined || node.encode === undefined) {
          throw new TreeManifestError(
            "format-incompatible",
            `tree format ${node.format} requires its store-aware adapter`,
          );
        }
        manifest = node.decode(candidate, ABSOLUTE_TREE_MANIFEST_LIMITS);
        if (manifest.format !== node.format) {
          throw new Error("tree format decoder returned a different format");
        }
      } catch (error) {
        throw new TreeManifestError(
          "object-integrity",
          "tree object contains an invalid manifest",
          error,
        );
      }
      const frozen = freezeTreeManifest(manifest);
      const canonicalBytes = node.encode(frozen, ABSOLUTE_TREE_MANIFEST_LIMITS);
      if (!canonicalBytes.equals(Buffer.from(content))) {
        throw new TreeManifestError(
          "object-integrity",
          "tree object is not canonically encoded",
        );
      }
      return frozen;
    },
    upgradeTo,
    referencedBlobOids(manifest) {
      return nodeFor(manifest).referencedBlobOids(manifest);
    },
  });
}
