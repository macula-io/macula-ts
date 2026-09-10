import { randomBytes } from "node:crypto";
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

        // The caller role: a real payload exercising the JsonValue
        // shapes other than bytes going IN -- text, an integer, a float,
        // null, and a nested list/map. (Bytes have their own test below.
        // A plain JSON string always becomes cbor.Text, so the
        // "0xdeadbeef"-shaped field is text that happens to look
        // hex-like, round-tripped as text -- not a test of byte encoding.)
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
    'bytes: {"$bytes": base64} goes IN as CBOR bytes and comes back OUT as hex by default, or tagged on request, on both the caller and the provider side',
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

        const procedure = uniqueProcedure("bytes_echo");

        // The provider asks for tagged bytes, so its handler sees exactly
        // what the caller sent, and returning that unchanged sends the
        // bytes back AS bytes: the "pass a returned id straight back"
        // property the tagged form exists for.
        const seenByProvider: JsonValue[] = [];
        stopServing = await providerSession.serve(
          procedure,
          (payload: JsonValue) => {
            seenByProvider.push(payload);
            return payload;
          },
          { bytes: "tagged" },
        );

        // "AQID" also appears as plain text, which must stay text both ways.
        const payload: JsonValue = { id: { $bytes: "AQID" }, list: [{ $bytes: "" }], text: "AQID" };

        // A station can still answer unknown_next_peer for a moment after
        // serve()'s advertise resolves (seen once while the live files ran
        // in parallel), so the first call gets a short bounded retry, like
        // directdial.live.test.ts's propagation-lag window. Only that
        // routing answer is retried; anything else fails the test at once.
        let tagged: JsonValue | undefined;
        for (let attempt = 1; tagged === undefined; attempt++) {
          try {
            tagged = await callerSession.call(procedure, payload, { deadlineMs: 15000, bytes: "tagged" });
          } catch (err) {
            if (!(err instanceof MaculaCallError) || err.bolt4Name !== "unknown_next_peer" || attempt >= 20) throw err;
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        expect(seenByProvider[0]).toEqual(payload);
        expect(tagged).toEqual(payload);

        // Same call, default output: the reply's bytes arrive as hex, which
        // also proves the provider's tagged reply went back as real bytes.
        const hex = await callerSession.call(procedure, payload, { deadlineMs: 15000 });
        expect(hex).toEqual({ id: "0x010203", list: ["0x"], text: "AQID" });
      } finally {
        if (stopServing) await stopServing();
        if (callerSession) await callerSession.close(callerId, "rpc.live.test.ts done (caller)");
        if (providerSession) await providerSession.close(providerId, "rpc.live.test.ts done (provider)");
        providerId.dispose();
        callerId.dispose();
      }
    },
    50000,
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

  it(
    "call()'s realm option actually changes wire behavior: the SAME procedure name is reachable under the realm " +
      "it's advertised in (the default, all-zero realm here -- serve() doesn't take a realm option yet) and comes " +
      "back unknown_next_peer under a different, real 32-byte realm -- not just a client-side no-op",
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

        const procedure = uniqueProcedure("realm_scoped");
        // serve()/advertise still only use the all-zero realm this
        // slice (session.ts's own doc) -- this procedure is therefore
        // reachable under realm:undefined (the default) and nowhere
        // else.
        stopServing = await providerSession.serve(procedure, () => "reached under the default realm");

        // Same realm (the default, implicit) as the provider -- reaches
        // it, proving the happy path still works with the new option
        // simply left unset.
        const defaultRealmResult = await callerSession.call(procedure, null, { deadlineMs: 15000 });
        expect(defaultRealmResult).toBe("reached under the default realm");

        // A real, random, non-zero 32-byte realm -- the SAME procedure
        // name, the SAME two live Sessions, only the realm differs.
        // This is the actual proof realm reaches the wire: a purely
        // decorative parameter would leave this call succeeding too.
        const otherRealm = randomBytes(32).toString("hex");
        let thrown: unknown;
        try {
          await callerSession.call(procedure, null, { deadlineMs: 15000, realm: otherRealm });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(MaculaCallError);
        expect((thrown as MaculaCallError).bolt4Name).toBe("unknown_next_peer");

        // And once more under the default realm, on the SAME two
        // Sessions, ruling out "the provider stopped answering" as an
        // alternative explanation for the unknown_next_peer above.
        const defaultRealmAgain = await callerSession.call(procedure, null, { deadlineMs: 15000 });
        expect(defaultRealmAgain).toBe("reached under the default realm");
      } finally {
        if (stopServing) await stopServing();
        if (callerSession) await callerSession.close(callerId, "rpc.live.test.ts done (realm isolation)");
        if (providerSession) await providerSession.close(providerId, "rpc.live.test.ts done (realm isolation)");
        providerId.dispose();
        callerId.dispose();
      }
    },
    45000,
  );

  it("call()/callWithUcan() reject a malformed realm before ever touching the network", async () => {
    const callerId = Identity.generate();
    let callerSession: Session | undefined;
    try {
      callerSession = await Session.connect(STATION_HOST, STATION_PORT, callerId);
      const procedure = uniqueProcedure("malformed_realm_never_called");

      // Too short, and not hex at all -- both must be rejected
      // synchronously (before this SDK ever encodes/signs/sends a
      // frame), not surfaced as some generic wire-level failure.
      await expect(callerSession.call(procedure, null, { realm: "not-hex", deadlineMs: 5000 })).rejects.toThrow(/64 hex characters/);
      await expect(callerSession.call(procedure, null, { realm: "ab", deadlineMs: 5000 })).rejects.toThrow(/64 hex characters/);
      await expect(callerSession.callWithUcan(procedure, null, "irrelevant.token.here", { realm: "zz".repeat(32), deadlineMs: 5000 })).rejects.toThrow(
        /64 hex characters/,
      );
    } finally {
      if (callerSession) await callerSession.close(callerId, "rpc.live.test.ts done (malformed realm)");
      callerId.dispose();
    }
  }, 20000);
});
