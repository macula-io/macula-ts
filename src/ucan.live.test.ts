import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, it, expect } from "vitest";
import { liveStationHost, requireLiveStation } from "../test/live_station.js";
import { Identity } from "./identity.js";
import { Session } from "./session.js";
import { Ucan } from "./ucan.js";
import { MaculaCallError, type JsonValue } from "./rpc.js";

// Opt-in only: MACULA_TS_LIVE=1 npm run test:live -- see
// session.live.test.ts for why (real production station, not run in
// default CI).
const STATION_HOST = liveStationHost("MACULA_TS_LIVE_STATION");
const STATION_PORT = 4433;

function uniqueProcedure(label: string): string {
  return `io.macula.ts.ucan_live_test.${label}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

// Records one wait: on the console, and in the file MACULA_TS_LIVE_WAITS names when set, since a
// test run's console output isn't always shown.
function recordWait(line: string): void {
  console.log(line);
  if (process.env.MACULA_TS_LIVE_WAITS) appendFileSync(process.env.MACULA_TS_LIVE_WAITS, `${line}\n`);
}

// How long a call may keep getting unknown_next_peer after serve() before the test fails: about six
// times the longest wait measured on a live station (one retry, about 300 ms). A wait near it is a
// station finding, not a reason to raise it.
const ROUTE_WAIT_MS = 2000;

// Calls until the station routes the CALL. serve()'s ADVERTISE is fire-and-forget, so a station can
// still answer unknown_next_peer for a moment after serve() resolves. Only that answer is retried,
// every 250 ms, for up to ROUTE_WAIT_MS; any other outcome is returned or thrown at once. Logs how
// many attempts the call took and how long it waited, so registration lag shows in the run.
async function whenRouted<T>(label: string, call: () => Promise<T>): Promise<T> {
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await call();
      recordWait(`live wait, ${label}: routed on attempt ${attempt} after ${Date.now() - start} ms`);
      return result;
    } catch (err) {
      const routing = err instanceof MaculaCallError && err.bolt4Name === "unknown_next_peer";
      if (!routing) {
        recordWait(`live wait, ${label}: answered on attempt ${attempt} after ${Date.now() - start} ms with ${String(err)}`);
        throw err;
      }
      if (Date.now() - start >= ROUTE_WAIT_MS) {
        recordWait(`live wait, ${label}: still unknown_next_peer on attempt ${attempt} after ${Date.now() - start} ms, giving up`);
        throw err;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
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
  beforeEach(() => requireLiveStation("MACULA_TS_LIVE_STATION"), 45_000);
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

        const ucan = Ucan.mint(callerId, callerId.nodeId, [{ with: `mri:test:${procedure}`, can: "call" }], {
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        });
        expect(ucan.token.split(".")).toHaveLength(3);
        expect(ucan.isExpired).toBe(false);

        const payload: JsonValue = { text: "hello with a real ucan attached", integer: 7 };
        const result = await whenRouted("ucan echo", () =>
          callerSession.callWithUcan(procedure, payload, ucan, { deadlineMs: 15000 }),
        );

        // A map payload reaches the provider with the caller its session verified under "caller"
        // (macula-go v0.10.0), as "0x" hex by default: this caller's own node id.
        expect(result).toEqual({
          echoed: { ...(payload as Record<string, JsonValue>), caller: `0x${Buffer.from(callerId.nodeId).toString("hex")}` },
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

        const ucan = Ucan.mint(callerId, callerId.nodeId);
        const result = await whenRouted("ucan raw token", () =>
          callerSession.callWithUcan(procedure, null, ucan.token, { deadlineMs: 15000 }),
        );
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

  it(
    "callWithUcan()'s realm option changes wire behavior exactly like call()'s does: reaches the procedure under " +
      "the realm it's advertised in, comes back unknown_next_peer under a different real realm",
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

        const procedure = uniqueProcedure("realm_scoped_ucan");
        stopServing = await providerSession.serve(procedure, () => "reached under the default realm");
        const ucan = Ucan.mint(callerId, callerId.nodeId);

        const defaultRealmResult = await callerSession.callWithUcan(procedure, null, ucan, { deadlineMs: 15000 });
        expect(defaultRealmResult).toBe("reached under the default realm");

        const otherRealm = randomBytes(32).toString("hex");
        let thrown: unknown;
        try {
          await callerSession.callWithUcan(procedure, null, ucan, { deadlineMs: 15000, realm: otherRealm });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(MaculaCallError);
        expect((thrown as MaculaCallError).bolt4Name).toBe("unknown_next_peer");
      } finally {
        if (stopServing) await stopServing();
        if (callerSession) await callerSession.close(callerId, "ucan.live.test.ts done (realm isolation)");
        if (providerSession) await providerSession.close(providerId, "ucan.live.test.ts done (realm isolation)");
        providerId.dispose();
        callerId.dispose();
      }
    },
    45000,
  );
});
