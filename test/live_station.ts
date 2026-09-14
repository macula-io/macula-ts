// Test-only support for the live test files: which station a live run uses, and a check that a session can
// be opened to it. It lives outside src, so tsc doesn't build it and the package doesn't ship it.
import { Identity } from "../src/identity.js";
import { Session } from "../src/session.js";

// The QUIC port every live station listens on.
export const LIVE_STATION_PORT = 4433;

// The station host named by `variable`, or "" when it isn't set. A live file reads its station through this
// and runs requireLiveStation before each test, so an unset variable fails the tests instead of skipping them.
export function liveStationHost(variable: string): string {
  return process.env[variable] ?? "";
}

// One check per variable and host in a test file's worker, shared by every test that asks: each test fails
// with the same message, and the station gets one probe session, not one per test.
const checks = new Map<string, Promise<void>>();

// Fails, naming `variable`, when it isn't set or no session can be opened to its station. The probe opens one
// Session under a throwaway identity and closes it; it fails on DNS, network, TLS and identity errors alike.
export function requireLiveStation(variable: string): Promise<void> {
  const host = process.env[variable] ?? "";
  const key = `${variable}=${host}`;
  const known = checks.get(key);
  if (known) return known;
  const check = probe(variable, host);
  checks.set(key, check);
  return check;
}

async function probe(variable: string, host: string): Promise<void> {
  if (!host) {
    throw new Error(`${variable} is not set: set it to the host name of the live station this run uses`);
  }
  const id = Identity.generate();
  try {
    const session = await Session.connect(host, LIVE_STATION_PORT, id);
    await session.close(id, "live station check");
  } catch (err) {
    throw new Error(`${variable}: could not open a session to ${host}:${LIVE_STATION_PORT}: ${String(err)}`);
  } finally {
    id.dispose();
  }
}
