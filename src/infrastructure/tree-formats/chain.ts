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

/** One published format and its conversion from the preceding table entry. */
export interface TreeFormat<Format extends string = string> {
  readonly format: Format;
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
  readonly formats: readonly TreeFormat[];
  readonly current: TreeFormat;
  parse(content: Uint8Array): TreeManifest;
  upgradeTo(
    manifest: TreeManifest,
    targetFormat: string,
    pathLimits: WorkspacePathLimits,
  ): TreeManifest;
  referencedBlobOids(manifest: TreeManifest): readonly string[];
}

/** Build direct format lookup from an oldest-to-current version table. */
export function createTreeFormatEngine(
  definitions: readonly TreeFormat[],
): TreeFormatEngine {
  if (definitions.length === 0)
    throw new Error("tree formats must not be empty");
  const byFormat = new Map<string, number>();
  for (const [index, node] of definitions.entries()) {
    if (node.format.length === 0 || byFormat.has(node.format)) {
      throw new Error("tree format history contains an invalid format id");
    }
    if (index > 0 && node.upgradeFromPrevious === undefined) {
      throw new Error(`tree format ${node.format} omits its adjacent upgrade`);
    }
    if (index === 0 && node.upgradeFromPrevious !== undefined) {
      throw new Error("first tree format cannot have an adjacent upgrade");
    }
    if ((node.decode === undefined) !== (node.encode === undefined)) {
      throw new Error(
        `tree format ${node.format} must define both inline codecs or neither`,
      );
    }
    byFormat.set(node.format, index);
  }
  const formats = Object.freeze(definitions.map((node) => Object.freeze(node)));
  const current = formats.at(-1)!;

  const nodeFor = (manifest: TreeManifest): TreeFormat => {
    const index = byFormat.get(manifest.format);
    if (index === undefined) {
      throw new TreeManifestError(
        "invalid-tree-manifest",
        "tree manifest format is outside the supported history",
      );
    }
    return formats[index]!;
  };

  const upgradeTo = (
    manifest: TreeManifest,
    targetFormat: string,
    pathLimits: WorkspacePathLimits,
  ): TreeManifest => {
    const source = nodeFor(manifest);
    const targetIndex = byFormat.get(targetFormat);
    if (targetIndex === undefined) {
      throw new TreeManifestError(
        "format-incompatible",
        `target tree format ${JSON.stringify(targetFormat)} is outside the supported history`,
      );
    }
    const sourceIndex = byFormat.get(source.format)!;
    if (sourceIndex === targetIndex) return freezeTreeManifest(manifest);
    if (targetIndex < sourceIndex) {
      throw new TreeManifestError(
        "format-incompatible",
        `tree format ${source.format} cannot be downgraded to ${targetFormat}`,
      );
    }

    let upgraded = manifest;
    for (let index = sourceIndex + 1; index <= targetIndex; index += 1) {
      const node = formats[index]!;
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
    formats,
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
      const index =
        typeof candidate.format === "string"
          ? byFormat.get(candidate.format)
          : undefined;
      if (index === undefined) {
        throw new TreeManifestError(
          "object-integrity",
          "tree object has an unsupported manifest format",
        );
      }

      const node = formats[index]!;
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
