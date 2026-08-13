import { createTreeFormatEngine } from "./chain.ts";
import { TREE_FORMAT_V2 } from "./v2.ts";

/** The sole pointer changed when a new tree format is published. */
export const CURRENT_TREE_FORMAT = TREE_FORMAT_V2;

/** One immutable registry shared by the current and historical APIs. */
export const TREE_FORMAT_REGISTRY = createTreeFormatEngine(CURRENT_TREE_FORMAT);
