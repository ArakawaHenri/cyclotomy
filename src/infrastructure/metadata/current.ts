import { V1_METADATA_VERSION } from "./versions/v1.ts";
import { V2_METADATA_VERSION } from "./versions/v2.ts";
import { V3_METADATA_VERSION } from "./versions/v3.ts";
import { V4_METADATA_VERSION } from "./versions/v4.ts";
import { V5_METADATA_VERSION } from "./versions/v5.ts";
import type { TreeFormat } from "../tree-formats/chain.ts";
import { TREE_FORMAT_REGISTRY } from "../tree-formats/registry.ts";
import { defineMetadataVersions, type MetadataVersion } from "./version.ts";

export const METADATA_VERSIONS = defineMetadataVersions([
  V1_METADATA_VERSION,
  V2_METADATA_VERSION,
  V3_METADATA_VERSION,
  V4_METADATA_VERSION,
  V5_METADATA_VERSION,
]);

export const CURRENT_METADATA_VERSION = METADATA_VERSIONS.at(-1)!;

/** Validate the two independent adjacent histories once at their composition root. */
export function validateMetadataTreeFormatComposition(
  metadataVersions: readonly MetadataVersion[],
  treeFormats: readonly TreeFormat[],
): void {
  const treeIndex = new Map(
    treeFormats.map((node, index) => [node.format, index] as const),
  );
  for (const [index, version] of metadataVersions.entries()) {
    if (!treeIndex.has(version.treeFormat)) {
      throw new Error(
        `metadata version ${version.version} names a tree format outside the supported history`,
      );
    }
    const previous = metadataVersions[index - 1];
    if (previous === undefined) continue;
    const previousIndex = treeIndex.get(previous.treeFormat)!;
    const currentIndex = treeIndex.get(version.treeFormat)!;
    if (currentIndex < previousIndex) {
      throw new Error(
        `metadata version ${version.version} moves its durable tree format backwards`,
      );
    }
    if (
      version.upgradeFromPrevious?.kind === "tree-format" &&
      currentIndex === previousIndex
    ) {
      throw new Error(
        `metadata version ${version.version} declares a tree-format edge without advancing the tree history`,
      );
    }
  }

  if (metadataVersions.at(-1)?.treeFormat !== treeFormats.at(-1)?.format) {
    throw new Error(
      "current metadata version must durably mark the current tree format",
    );
  }
}

validateMetadataTreeFormatComposition(
  METADATA_VERSIONS,
  TREE_FORMAT_REGISTRY.formats,
);
