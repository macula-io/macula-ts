// Runs macula-go's teststation (built to native/build/teststation by
// scripts/build-native.sh, from the macula-go release in native/MACULA_GO) for a
// test file: two in-process macula 12 stations
// sharing a DHT and a test realm, driven over the helper's stdin.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "build", "teststation");

export interface TestStations {
  readonly stations: ReadonlyArray<{ host: string; port: number; node_id: string }>;
  readonly realmId: string;
  readonly realmKey: string;
  readonly org: string;
  /** The org delegates its procedures to the node. */
  admit(nodeId: string): Promise<void>;
  /** How many streams the stations relay now. */
  relayed(): Promise<number>;
  stop(): void;
}

export async function startStations(): Promise<TestStations> {
  const child: ChildProcessWithoutNullStreams = spawn(binary, ["pq_pure"]);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) throw new Error("teststation printed nothing");
  const info = JSON.parse(first.value as string);
  let queue = Promise.resolve();
  const ask = (command: string): Promise<string> => {
    const answer = queue.then(async () => {
      child.stdin.write(command + "\n");
      const reply = await lines.next();
      if (reply.done) throw new Error("teststation ended");
      return reply.value as string;
    });
    queue = answer.then(() => undefined, () => undefined);
    return answer;
  };
  return {
    stations: info.stations,
    realmId: info.realm_id,
    realmKey: info.realm_key,
    org: info.org,
    async admit(nodeId: string) {
      const reply = await ask(`admit ${nodeId}`);
      if (!reply.startsWith("admitted")) throw new Error(reply);
    },
    async relayed() {
      return Number((await ask("relayed")).split(" ")[1]);
    },
    stop() {
      child.stdin.end();
      child.kill();
    },
  };
}
