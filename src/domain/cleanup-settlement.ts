/** Final cleanup state for an operational resource owned by one boundary. */
export type CleanupSettlement =
  | { readonly kind: "settled" }
  | { readonly kind: "failed"; readonly cause: unknown };
