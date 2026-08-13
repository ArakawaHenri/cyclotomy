import type { TreeEntry } from "./manifest-codec.ts";

/** Extract each content-addressed blob reference once, in manifest order. */
export function referencedTreeBlobOids(
  entries: readonly TreeEntry[],
): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "regular" && !seen.has(entry.blobOid)) {
      seen.add(entry.blobOid);
      result.push(entry.blobOid);
    }
  }
  return result;
}
