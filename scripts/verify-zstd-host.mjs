import assert from "node:assert/strict";

import {
  decodeZstdV1,
  encodeZstdV1,
} from "../src/infrastructure/content-store/zstd.ts";
import {
  authenticateFullRecordPayload,
  createContentRecord,
} from "../src/infrastructure/content-store/representation.ts";

function deterministicBytes(length) {
  const bytes = new Uint8Array(length);
  let state = 0x1234_5678;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

const exactFillInput = deterministicBytes(16_370);
const exactFillEncoded = await encodeZstdV1(exactFillInput);
assert.equal(
  exactFillEncoded.byteLength,
  16 * 1024,
  "fixture must exactly fill node:zlib's default output chunk",
);
assert.deepEqual(
  Uint8Array.from(
    await decodeZstdV1(exactFillEncoded, exactFillInput.byteLength),
  ),
  exactFillInput,
);

const productionInput = deterministicBytes(20_000);
productionInput.fill(0, 0, 3_000);
const record = await createContentRecord(productionInput);
assert.equal(record.encoding, "zstd-v1");
assert.ok(
  record.payload.byteLength > 16 * 1024,
  "production fixture must cross node:zlib's default output chunk",
);
assert.deepEqual(
  Uint8Array.from(await authenticateFullRecordPayload(record)),
  productionInput,
);
