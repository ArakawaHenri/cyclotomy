import { createHash } from "node:crypto";

declare const CONTENT_ID: unique symbol;
declare const METADATA_ID: unique symbol;
declare const RECIPE_ID: unique symbol;

/** SHA-256 of the exact decoded bytes; intentionally identical to legacy OIDs. */
export type ContentId = string & { readonly [CONTENT_ID]: true };

/** Domain-separated SHA-256 identity for canonical metadata objects. */
export type MetadataId = string & { readonly [METADATA_ID]: true };

/** SHA-256 of a fixed domain tag followed by canonical recipe bytes. */
export type RecipeId = MetadataId & { readonly [RECIPE_ID]: true };

export type LogicalId = ContentId | MetadataId;

export const SHA256_BYTE_LENGTH = 32;
export const SHA256_HEX_LENGTH = SHA256_BYTE_LENGTH * 2;
export const RECIPE_ID_DOMAIN_TAG = "cyclotomy.recipe.v1\0";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function digestHex(parts: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest("hex");
}

export function contentIdFromBytes(bytes: Uint8Array): ContentId {
  return digestHex([bytes]) as ContentId;
}

export function recipeIdFromCanonicalBytes(bytes: Uint8Array): RecipeId {
  return digestHex([
    Buffer.from(RECIPE_ID_DOMAIN_TAG, "utf8"),
    bytes,
  ]) as RecipeId;
}

function parseSha256(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(
      `${label} must be exactly 64 lowercase hexadecimal digits`,
    );
  }
  return value;
}

export function parseContentId(value: string): ContentId {
  return parseSha256(value, "content id") as ContentId;
}

export function parseRecipeId(value: string): RecipeId {
  return parseSha256(value, "recipe id") as RecipeId;
}

export function parseMetadataId(value: string): MetadataId {
  return parseSha256(value, "metadata id") as MetadataId;
}

export function idToBytes(id: LogicalId): Uint8Array {
  return Uint8Array.from(Buffer.from(parseSha256(id, "logical id"), "hex"));
}

export function contentIdFromDigestBytes(bytes: Uint8Array): ContentId {
  if (bytes.byteLength !== SHA256_BYTE_LENGTH) {
    throw new TypeError(
      `content id digest must be ${SHA256_BYTE_LENGTH} bytes`,
    );
  }
  return Buffer.from(bytes).toString("hex") as ContentId;
}

export function recipeIdFromDigestBytes(bytes: Uint8Array): RecipeId {
  if (bytes.byteLength !== SHA256_BYTE_LENGTH) {
    throw new TypeError(`recipe id digest must be ${SHA256_BYTE_LENGTH} bytes`);
  }
  return Buffer.from(bytes).toString("hex") as RecipeId;
}

export function metadataIdFromDigestBytes(bytes: Uint8Array): MetadataId {
  if (bytes.byteLength !== SHA256_BYTE_LENGTH) {
    throw new TypeError(
      `metadata id digest must be ${SHA256_BYTE_LENGTH} bytes`,
    );
  }
  return Buffer.from(bytes).toString("hex") as MetadataId;
}
