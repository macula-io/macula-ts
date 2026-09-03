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
  return `io.macula.ts.ucan_live_test.${label}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

// IMPORTANT, honest scope note: this SDK does not implement provider-
// side UCAN gating (macula-go's ucan.Policy / ServeOneCallGated -- see
// ucan.ts's own module doc, out of scope for this slice). The test below
// therefore proves the CLIENT-side attach-and-call mechanism end to end
// against a real station -- a freshly minted token really is attached to
// a real CALL frame and a real RESULT comes back -- but it does NOT (and
// cannot, without a gated provider on the other end) prove that a
// station or provider actually ENFORCES the token. That is a real,
// stated limitation, not a hidden gap: macula-go's own
// connection.Session.CallWithUCAN is exercised for real here, the same
// function macula_call_with_ucan (macula-php) and this SDK's own
// macula_session_call_with_ucan wrap, and macula-go's own
// connection/serve_ucan_test.go and directdial_live_test.go already
// prove the enforcement side of this protocol works when a gated
// provider IS present.
describe.skipIf(!process.env.MACULA_TS_LIVE)("Session.callWithUcan (live station)", () => {
  it(
    "attaches a freshly minted UCAN to a real CALL and completes it end to end against an ordinary served procedure",
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

        const procedure = uniqueProcedure("gated_shape_echo");

        // Not actually gated (this SDK has no served-side UCAN policy --
        // see this file's own module doc) -- an ordinary echo handler,
        // proving the token really reached the wire and the call
        // completed, not that the provider checked it.
        stopServing = await providerSession.serve(procedure, (payload: JsonValue) => {
          return { echoed: payload, handled_by: "macula-ts-ucan-live-test-provider" };
        });

        const ucan = Ucan.mint(callerId, providerId.nodeId, [{ with: `mri:test:${procedure}`, can: "call" }], {
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        });
        expect(ucan.token.split(".")).toHaveLength(3);
        expect(ucan.isExpired).toBe(false);

        const payload: JsonValue = { text: "hello with a real ucan attached", integer: 7 };
        const result = await callerSession.callWithUcan(procedure, payload, ucan, { deadlineMs: 15000 });

        expect(result).toEqual({
          echoed: payload,
          handled_by: "macula-ts-ucan-live-test-provider",
        });
      } finally {
        if (stopServing) await stopServing();
        if (callerSession) await callerSession.close(callerId, "ucan.live.test.ts done (caller)");
        if (providerSession) await providerSession.close(providerId, "ucan.live.test.ts done (provider)");
        providerId.dispose();
        callerId.dispose();
      }
    },
    35000,
  );

  it(
    "callWithUcan() also accepts a raw token string (not just a Ucan object)",
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

        const procedure = uniqueProcedure("raw_token_string");
        stopServing = await providerSession.serve(procedure, () => "ok");

        const ucan = Ucan.mint(callerId, providerId.nodeId);
        const result = await callerSession.callWithUcan(procedure, null, ucan.token, { deadlineMs: 15000 });
        expect(result).toBe("ok");
      } finally {
        if (stopServing) await stopServing();
        if (callerSession) await callerSession.close(callerId, "ucan.live.test.ts done (raw token)");
        if (providerSession) await providerSession.close(providerId, "ucan.live.test.ts done (raw token)");
        providerId.dispose();
        callerId.dispose();
      }
    },
    35000,
  );

  it(
    "callWithUcan() to a procedure nobody has advertised still comes back a real, structured unknown_next_peer -- the token doesn't change ordinary CALL error behavior",
    async () => {
      const callerId = Identity.generate();
      let callerSession: Session | undefined;
      try {
        callerSession = await Session.connect(STATION_HOST, STATION_PORT, callerId);
        const ucan = Ucan.mint(callerId, callerId.nodeId);
        const nobodyAdvertisedThis = uniqueProcedure("nobody_advertised_this");

        let thrown: unknown;
        try {
          await callerSession.callWithUcan(nobodyAdvertisedThis, "irrelevant payload", ucan, { deadlineMs: 10000 });
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(MaculaCallError);
        expect((thrown as MaculaCallError).bolt4Name).toBe("unknown_next_peer");
      } finally {
        if (callerSession) await callerSession.close(callerId, "ucan.live.test.ts done (negative case)");
        callerId.dispose();
      }
    },
    20000,
  );
});
