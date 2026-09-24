// What every example joins the mesh with, from the environment:
//   MACULA_SEED       the station, host:port ([v6]:port for IPv6)
//   MACULA_STATION_ID its node_id, 64 hex: the station must prove it
//   MACULA_REALM      the realm id, 64 hex
//   MACULA_REALM_KEY  the realm's key as carried, hex (the realm publishes it)
//   MACULA_KEY        this node's key file, created on first use (node.key)
import { NodeKey, Pool } from "../dist/index.js";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name} (see examples/README.md)`);
  return value;
}

export const realm = (): string => env("MACULA_REALM");

export async function connect(keyFile = process.env.MACULA_KEY ?? "node.key"): Promise<Pool> {
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(env("MACULA_SEED"));
  if (!match) throw new Error("MACULA_SEED must be host:port");
  const key = await NodeKey.loadOrCreate(keyFile);
  return Pool.connect(key, [{ host: match[1]!, port: Number(match[2]), nodeId: env("MACULA_STATION_ID") }], {
    realmTrust: [{ realm: env("MACULA_REALM"), key: env("MACULA_REALM_KEY") }],
  });
}
