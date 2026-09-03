import { describe, it, expect } from "vitest";
import { Identity } from "./identity.js";
import { Session } from "./session.js";
import { Ucan } from "./ucan.js";
import { MaculaCallError, type JsonValue } from "./rpc.js";

// Opt-in only: MACULA_TS_LIVE=1 npm run test:live -- see
// session.live.test.ts for why (real production station, not run in
// default CI).
const STATION_HOST = "station-de-frankfurt.macula.io";
const STATION_PORT = 4433;

function uniqueProcedure(label: string): string {
  return `io.macula.ts.directdial_live_test.${label}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

// Every test below is SELF-CONTAINED: it makes its own procedure
// direct-dialable via advertiseDirect() first (the provider-side half
// this stage adds), then reaches it purely through resolveDirect()/
// callDirect() (the caller-side half) -- not dependent on finding some
// pre-existing direct-dialable procedure on the shared demo fleet, the
// same self-verification shape the RPC stage's own live test uses for
// call()/serve().
describe.skipIf(!process.env.MACULA_TS_LIVE)("Session direct-dial (live station)", () => {
  it(
    "advertiseDirect() makes a procedure resolvable AND reachable: resolveDirect() finds the real serving " +
      "station this Session is connected to, and callDirect() completes a real one-hop round trip through it",
    async () => {
      const providerId = Identity.generate();
      const callerId = Identity.generate();
      let providerSession: Session | undefined;
      let callerSession: Session | undefined;
      let stopServing: (() => Promise<void>) | undefined;

      try {
        // Distinct identities for provider vs caller, deliberately: this
        // fleet enforces one connection per identity and kicks whichever
        // connects second -- sharing one identity across both roles
        // would kick the provider's own connection (and its ADVERTISE
        // registration with it) the moment the caller side connects.
        providerSession = await Session.connect(STATION_HOST, STATION_PORT, providerId);

        const procedure = uniqueProcedure("resolve_and_call");

        // Provider side: publish this procedure as direct-dial-reachable
        // BEFORE starting to serve it -- advertiseDirect()'s own PutRecord
        // CALL must not race an active serve() loop's reads of the same
        // shared control stream (see advertiseDirect()'s own doc), so
        // this order matters, not just happens to work.
        await providerSession.advertiseDirect(procedure, { ttlMs: 5 * 60_000 });

        stopServing = await providerSession.serve(procedure, (payload: JsonValue) => {
          return { echoed: payload, handled_by: "macula-ts-directdial-live-test-provider" };
        });

        callerSession = await Session.connect(STATION_HOST, STATION_PORT, callerId);

        // resolveDirect() on its own first: proves the DHT chain (a
        // signed procedure_advertisement resolving to a signed, live
        // station_endpoint) genuinely resolves to the REAL station the
        // provider is connected to -- not a stale or wrong one.
        const target = await callerSession.resolveDirect(procedure);
        expect(target.station).toBe(Buffer.from(providerSession.stationNodeId).toString("hex"));
        expect(target.host.length).toBeGreaterThan(0);
        expect(target.port).toBeGreaterThan(0);

        const payload: JsonValue = { text: "hello via direct-dial", integer: 99, nested: { list: [1, 2, 3] } };
        const result = await callerSession.callDirect(procedure, payload, { deadlineMs: 15000 });

        expect(result).toEqual({
          echoed: payload,
          handled_by: "macula-ts-directdial-live-test-provider",
        });
      } finally {
        if (stopServing) await stopServing();
        if (callerSession) await callerSession.close(callerId, "directdial.live.test.ts done (caller)");
        if (providerSession) await providerSession.close(providerId, "directdial.live.test.ts done (provider)");
        providerId.dispose();
        callerId.dispose();
      }
    },
    40000,
  );

  it(
    "callDirectWithUcan() attaches a freshly minted UCAN to a real direct-dial CALL and completes it end to end " +
      "(honest limitation: this SDK has no served-side UCAN policy gate -- see ucan.ts's own doc -- so this " +
      "proves the client-side attach-and-call mechanism reaches an ungated procedure over direct-dial, not that " +
      "a provider enforces the token; macula-go's own directdial_live_test.go TestLiveDirectDialUCANGatedRoundTrip " +
      "already proves the enforcement side of this exact protocol against a gated provider)",
    async () => {
      const providerId = Identity.generate();
      const callerId = Identity.generate();
      let providerSession: Session | undefined;
      let callerSession: Session | undefined;
      let stopServing: (() => Promise<void>) | undefined;

      try {
        providerSession = await Session.connect(STATION_HOST, STATION_PORT, providerId);
        const procedure = uniqueProcedure("ucan_attach");
        await providerSession.advertiseDirect(procedure, { ttlMs: 5 * 60_000 });
        stopServing = await providerSession.serve(procedure, () => "reached via direct-dial with a ucan attached");

        callerSession = await Session.connect(STATION_HOST, STATION_PORT, callerId);
        const ucan = Ucan.mint(callerId, providerId.nodeId, [{ with: `mri:test:${procedure}`, can: "call" }], {
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        });

        const result = await callerSession.callDirectWithUcan(procedure, null, ucan, { deadlineMs: 15000 });
        expect(result).toBe("reached via direct-dial with a ucan attached");
      } finally {
        if (stopServing) await stopServing();
        if (callerSession) await callerSession.close(callerId, "directdial.live.test.ts done (ucan)");
        if (providerSession) await providerSession.close(providerId, "directdial.live.test.ts done (ucan)");
        providerId.dispose();
        callerId.dispose();
      }
    },
    40000,
  );

  it(
    "resolveDirect()/callDirect() to a procedure nobody ever called advertiseDirect() for fail with a real, " +
      "clear error after a bounded DHT-propagation-lag retry window -- not a hang and not a false success",
    async () => {
      const callerId = Identity.generate();
      let callerSession: Session | undefined;
      try {
        callerSession = await Session.connect(STATION_HOST, STATION_PORT, callerId);
        const nobodyAdvertisedThis = uniqueProcedure("nobody_advertised_this");

        const startedAt = Date.now();
        await expect(callerSession.resolveDirect(nobodyAdvertisedThis)).rejects.toThrow(
          /procedure has no direct-dial advertisement/,
        );
        // Proves this actually went through macula-go's real bounded
        // retry window (~50 attempts x 100ms) rather than failing
        // suspiciously instantly on some unrelated client-side error.
        expect(Date.now() - startedAt).toBeGreaterThan(1000);

        let thrown: unknown;
        try {
          await callerSession.callDirect(nobodyAdvertisedThis, "irrelevant payload", { deadlineMs: 15000 });
        } catch (err) {
          thrown = err;
        }
        // A resolve failure is a local/transport-level failure (this
        // procedure never got far enough to reach a real peer at all),
        // not a wire-level BOLT#4 answer -- so this rejects with a plain
        // Error, NOT a MaculaCallError, exactly like a resolve failure
        // inside macula-go's own Call (cabi/directdial.go's own doc on
        // the errOut/envelope split, extended to cover the resolve+dial
        // stage in front of the call itself).
        expect(thrown).not.toBeInstanceOf(MaculaCallError);
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toMatch(/procedure has no direct-dial advertisement/);
      } finally {
        if (callerSession) await callerSession.close(callerId, "directdial.live.test.ts done (negative case)");
        callerId.dispose();
      }
    },
    30000,
  );
});
