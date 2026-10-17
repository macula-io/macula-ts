// A station's verdict on a serve or subscribe (macula-go cabi "Errors", kind
// refused, since v0.27.0-rc.4) arrives as RefusedError with the station's
// reason, the registration it refused and the station's node_id; any other
// refusal carries none of them.
import { describe, expect, it } from "vitest";
import { MaculaError, RefusedError } from "./index.js";
import { nativeError } from "./wire.js";

const station = "ab".repeat(32);

describe("a refused registration", () => {
  it("names the station's reason, the registration and the station", () => {
    const e = nativeError(new Error(JSON.stringify({
      kind: "refused", message: "the station refused the advertisement", reason: "too_many_providers",
      registration: "advertise", station })));
    expect(e).toBeInstanceOf(RefusedError);
    expect(e).toBeInstanceOf(MaculaError);
    const r = e as RefusedError;
    expect(r.kind).toBe("refused");
    expect(r.reason).toBe("too_many_providers");
    expect(r.registration).toBe("advertise");
    expect(r.station).toBe(station);
  });

  it("is unacknowledged when no station answered", () => {
    const r = nativeError(new Error(JSON.stringify({
      kind: "refused", message: "no station answered", reason: "unacknowledged", registration: "subscribe", station })));
    expect(r).toBeInstanceOf(RefusedError);
    expect((r as RefusedError).reason).toBe("unacknowledged");
    expect((r as RefusedError).registration).toBe("subscribe");
  });

  it("carries nulls for a refusal that is not a registration's", () => {
    const r = nativeError(new Error(JSON.stringify({ kind: "refused", message: "the realm refused the admission" })));
    expect(r).toBeInstanceOf(RefusedError);
    expect((r as RefusedError).reason).toBeNull();
    expect((r as RefusedError).registration).toBeNull();
    expect((r as RefusedError).station).toBeNull();
  });
});
