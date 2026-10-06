import { defineConfig } from "vitest/config";

// Tests make pq_hybrid keys (ML-DSA-87 plus RSA-4096) and start in-process
// stations, which takes seconds on a CPU-capped runner: vitest's 5 s default
// failed five of them there while the code was fine (macula-ts#14, #16). A
// test that hangs still fails, at 30 s.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
