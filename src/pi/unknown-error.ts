/** Best-effort text for an arbitrary thrown value, including hostile coercion. */
export function messageOfUnknown(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return "unprintable failure";
  }
}
