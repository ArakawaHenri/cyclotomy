# Performance measurements

Performance claims require fixed inputs and a recorded environment. Functional tests verify checkpoint integrity, retained-object safety, cancellation and resource cleanup; they do not impose wall-clock thresholds on shared CI runners.

## Capture and restore

Capture retains two complete content observations, including Git policy sources, scope and directory identity. File timestamps are not unique content versions and cannot replace the final content scan.

`npm run test:performance` measures scanning and publication for large repeated content, many small files, unique compressed files and existing pack history. The output includes wall time, CPU time, event-loop delay and synchronization calls. These are diagnostic indicators, not acceptance scores.

For version comparisons, use identical input data and Node/Pi versions, fresh stores for destructive passes, warmup runs and alternating version order. Keep setup and result verification outside the timed operation. Record the hardware, filesystem, cache conditions and raw samples, and verify that both versions produce equivalent content.

## GC

`npm run test:performance:gc` runs `scripts/gc-performance.ts` in a separate Node process with explicit GC available. Its default datasets have 32 and 320 historical roots, each describing 64 files of 1 KiB. Every additional root changes 16 bytes in one file. Each dataset also includes unreferenced data proportional to the distinct live blobs.

The script reports duration, sampled peak RSS, file descriptors and actual reclamation. It also verifies that unreferenced sample objects were removed and a retained checkpoint remains readable. Repeat measurements from independently prepared starting states.

Larger runs use explicit dataset parameters:

```sh
CYCLOTOMY_GC_BENCH_ROOTS=1000 CYCLOTOMY_GC_BENCH_FILES=1000 npm run test:performance:gc
```

The intended reference dataset is 1,000 / 10,000 roots with 1,000 files per tree on a fixed local Linux x86_64 machine. Reference budgets are a peak-RSS increase of at most 128 MiB as roots grow tenfold, a duration ratio at most 15, and at most 64 extra file descriptors. These are targets until measured on the registered reference environment; a laptop run does not establish compliance.

GC currently retains roots, inventory and mark data in memory. It holds the workspace lock for the operation and supports cancellation between safe work boundaries. Completed publications and deletions remain valid after cancellation, and the automatic schedule records only completed passes. No constant-memory or strict latency guarantee is implied.

Automatic GC is scheduled after foreground work and runs only while Pi is idle. Local activity cancels it immediately; external foreground contention requests cancellation through the operating-system demand locks. Measure demand-to-lock-release latency separately from complete GC duration, including cancellation during inventory, planning, encoding, temporary writes and publication. A publication that has become visible finishes its durability boundary before releasing the workspace lock.
