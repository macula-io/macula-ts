import { describe, it, expect } from "vitest";
import { Identity } from "./identity.js";
import { Session } from "./session.js";
import { MaculaCallError, type JsonValue } from "./rpc.js";

// Opt-in only: MACULA_TS_LIVE=1 npm run test:live -- see
// session.live.test.ts for why (real production station, not run in
// default CI).
const STATION_HOST = "station-de-frankfurt.macula.io";
const STATION_PORT = 4433;

// A fresh, unlikely-to-collide procedure name per test run -- the
// shared demo fleet has other traffic on it, so this must not shadow
// anything real. Matches the task's own instruction to include a
// timestamp/random suffix.
function uniqueProcedure(label: string): string {
  return `io.macula.ts.rpc_live_test.${label}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

describe.skipIf(!process.env.MACULA_TS_LIVE)("Session RPC (live station)", () => {
  it(
    "a provider's serve() answers a caller's call() with the real round-tripped payload, over two real Sessions",
    async () => {
      const providerId = Identity.generate();
      const callerId = Identity.generate();
      let providerSession: Session | undefined;
      let callerSession: Session | undefined;
      let stopServing: (() => Promise<void>) | undefined;

      try {
        [providerSession, callerSession] = await Promise.all([
          Session.connect(STATION_HOST, STATION_PORT, providerId),
          Session.connect(STATION_HOST, STATION_PORT, callerId),
        ]);

        const procedure = uniqueProcedure("echo");

        // The provider role: echo whatever payload it receives, plus
        // proof the handler itself actually ran (not a stub) by
        // wrapping the payload rather than just returning it verbatim.
        stopServing = await providerSession.serve(procedure, (payload: JsonValue) => {
          return { echoed: payload, handled_by: "macula-ts-live-test-provider" };
        });

        // The caller role: a real payload exercising every JsonValue
        // shape this SDK's wire encoding supports going IN -- text, an
        // integer, a float, null, and a nested list/map. (Bytes are
        // one-directional in this encoding: cabi/wirevalue.go's
        // cborToJSON renders a cbor.Value of KindBytes as a
        // "0x"-prefixed hex string coming OUT, but jsonToCbor never
        // turns such a string back into KindBytes going IN -- a plain
        // JSON string always becomes cbor.Text, matching macula-cli's
        // own wirevalue package this was ported from. The
        // "0xdeadbeef"-shaped field below is therefore just text that
        // happens to look hex-like, round-tripped as text -- not a
        // test of byte encoding.)
        const payload: JsonValue = {
          text: "hello from macula-ts",
          integer: 42,
          float: 3.5,
          nothing: null,
          nested: { list: [1, 2, 3], hexlike_text: "0xdeadbeef" },
        };

        const result = await callerSession.call(procedure, payload, { deadlineMs: 15000 });

        expect(result).toEqual({
          echoed: payload,
          handled_by: "macula-ts-live-test-provider",
        });
      } finally {
        if (stopServing) await stopServing();
        if (callerSession) await callerSession.close(callerId, "rpc.live.test.ts done (caller)");
        if (providerSession) await providerSession.close(providerId, "rpc.live.test.ts done (provider)");
        providerId.dispose();
        callerId.dispose();
      }
    },
    35000,
  );

  it(
    "calling a procedure nobody has advertised comes back as a real, structured unknown_next_peer -- not a hang or a crash",
    async () => {
      const callerId = Identity.generate();
      let callerSession: Session | undefined;
      try {
        callerSession = await Session.connect(STATION_HOST, STATION_PORT, callerId);
        const nobodyAdvertisedThis = uniqueProcedure("nobody_advertised_this");

        let thrown: unknown;
        try {
          await callerSession.call(nobodyAdvertisedThis, "irrelevant payload", { deadlineMs: 10000 });
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(MaculaCallError);
        const err = thrown as MaculaCallError;
        expect(err.bolt4Name).toBe("unknown_next_peer");
        expect(err.code).toBe(0x01);
        expect(typeof err.retryable).toBe("boolean");
      } finally {
        if (callerSession) await callerSession.close(callerId, "rpc.live.test.ts done (negative case)");
        callerId.dispose();
      }
    },
    20000,
  );

  it("a provider handler that throws answers the caller with a structured unknown_error, not a hang", async () => {
    const providerId = Identity.generate();
    const callerId = Identity.generate();
    let providerSession: Session | undefined;
    let callerSession: Session | undefined;
    let stopServing: (() => Promise<void>) | undefined;

    try {
      [providerSession, callerSession] = await Promise.all([
        Session.connect(STATION_HOST, STATION_PORT, providerId),
        Session.connect(STATION_HOST, STATION_PORT, callerId),
      ]);

      const procedure = uniqueProcedure("always_throws");
      stopServing = await providerSession.serve(procedure, () => {
        throw new Error("macula-ts-live-test: deliberate handler failure");
      });

      let thrown: unknown;
      try {
        await callerSession.call(procedure, null, { deadlineMs: 15000 });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(MaculaCallError);
      const err = thrown as MaculaCallError;
      expect(err.bolt4Name).toBe("unknown_error");
      expect(err.detail).toContain("deliberate handler failure");
    } finally {
      if (stopServing) await stopServing();
      if (callerSession) await callerSession.close(callerId, "rpc.live.test.ts done (handler error)");
      if (providerSession) await providerSession.close(providerId, "rpc.live.test.ts done (handler error)");
      providerId.dispose();
      callerId.dispose();
    }
  }, 35000);
});
