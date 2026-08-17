import { V4_METADATA_VERSION } from "./versions/v4.ts";
import { treeFormatChain, type TreeFormatNode } from "../tree-formats/chain.ts";
import { TREE_FORMAT_REGISTRY } from "../tree-formats/registry.ts";
import { metadataVersionChain, type MetadataVersionNode } from "./version.ts";

/** Validate the two independent adjacent histories once at their composition root. */
export function validateMetadataTreeFormatComposition(
  currentMetadata: MetadataVersionNode,
  currentTree: TreeFormatNode,
): void {
  const treeFormats = treeFormatChain(currentTree);
  const treeIndex = new Map(
    treeFormats.map((node, index) => [node.format, index] as const),
  );
  const metadataVersions = metadataVersionChain(currentMetadata);

  for (const version of metadataVersions) {
    if (!treeIndex.has(version.treeFormat)) {
      throw new Error(
        `metadata version ${version.version} names a tree format outside the supported history`,
      );
    }
    if (version.previous === undefined) continue;
    const previousIndex = treeIndex.get(version.previous.treeFormat)!;
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

/** The sole pointer changed when a new published metadata version is added. */
export const CURRENT_METADATA_VERSION = V4_METADATA_VERSION;

validateMetadataTreeFormatComposition(
  CURRENT_METADATA_VERSION,
  TREE_FORMAT_REGISTRY.current,
);
