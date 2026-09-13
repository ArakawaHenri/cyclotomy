import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";

const binding = createRequire(import.meta.url)(
  join(
    workerData.root,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "file-lock.node",
  ),
);
const file = binding.open(workerData.path);
parentPort.postMessage(file.tryLock());
setInterval(() => file.stat(), 1000);
