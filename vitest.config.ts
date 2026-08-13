import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Process/I/O harnesses own their diagnostic 30 s watchdogs. Keep the
    // runner outside that boundary so their finally blocks can unwind cleanly.
    hookTimeout: 40_000,
    testTimeout: 40_000,
  },
});
