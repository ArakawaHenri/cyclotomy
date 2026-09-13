import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const binding = createRequire(import.meta.url)(workerData.bindingPath);
const files = Array.from({ length: 16 }, () => binding.open(workerData.path));
if (workerData.close) {
  for (const file of files) {
    file.close();
    file.close();
    assert.throws(() => file.tryLock(), { code: "EBADF" });
    assert.throws(() => file.stat(), { code: "EBADF" });
  }
}
parentPort.postMessage(binding.outstanding());
setInterval(() => files.length, 1000);
