// Test-only support for the live test file: which station and realm a live
// run uses. It lives outside src, so tsc doesn't build it and the package
// doesn't ship it. Every variable must be set when MACULA_TS_LIVE is: an
// unset one fails the tests, naming it, rather than skipping them.
export interface LiveStation {
  readonly host: string;
  readonly port: number;
  readonly nodeId: string;
  readonly realm: string;
  readonly realmKey: string;
}

const variables = ["MACULA_TS_LIVE_SEED", "MACULA_TS_LIVE_STATION_ID", "MACULA_TS_LIVE_REALM", "MACULA_TS_LIVE_REALM_KEY"];

/** The live station, pinned by node_id, and the realm whose key the run
 * trusts. MACULA_TS_LIVE_SEED is host:port ([v6]:port for IPv6). */
export function liveStation(): LiveStation {
  const missing = variables.filter((v) => !process.env[v]);
  if (missing.length > 0) throw new Error(`live tests need ${missing.join(", ")}`);
  const seed = process.env.MACULA_TS_LIVE_SEED!;
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(seed);
  if (!match) throw new Error(`MACULA_TS_LIVE_SEED must be host:port, got ${seed}`);
  return {
    host: match[1]!,
    port: Number(match[2]),
    nodeId: process.env.MACULA_TS_LIVE_STATION_ID!,
    realm: process.env.MACULA_TS_LIVE_REALM!,
    realmKey: process.env.MACULA_TS_LIVE_REALM_KEY!,
  };
}
