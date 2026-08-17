import { createTreeFormatEngine } from "./chain.ts";
import { TREE_FORMAT_V3 } from "./v3.ts";

/** Immutable history used only by migration and version-chain validation. */
export const TREE_FORMAT_REGISTRY = createTreeFormatEngine(TREE_FORMAT_V3);
