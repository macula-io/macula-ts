import { describe, it, expect } from "vitest";
import { bytesModeFor } from "./rpc.js";

// bytesModeFor is the one place a caller's `bytes` option becomes the
// integer cabi's bytesOutput takes. Plain JavaScript can pass anything, so
// an unknown value must throw here, not reach Go and not quietly mean hex.
describe("bytesModeFor", () => {
  it('maps an omitted option and "hex" to 0, and "tagged" to 1', () => {
    expect(bytesModeFor(undefined)).toBe(0);
    expect(bytesModeFor("hex")).toBe(0);
    expect(bytesModeFor("tagged")).toBe(1);
  });

  it("throws on anything else instead of falling back to hex", () => {
    for (const bad of ["base64", "HEX", "", 1, null]) {
      expect(() => bytesModeFor(bad as never)).toThrow(/bytes must be "hex" or "tagged"/);
    }
  });
});
