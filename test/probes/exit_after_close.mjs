// process.exit() right after a listener's source ends (MODE=close: the pool
// closes; MODE=stop: the subscription stops), before the loop turns: the
// process must exit 0, with no listener state torn down under a thread.
import { NodeKey, Pool } from "../../dist/index.js";

const [host, port, nodeId, realm] = process.argv.slice(2);
const pool = await Pool.connect(await NodeKey.generate("pq_pure"), [{ host, port: Number(port), nodeId }]);
const sub = await pool.subscribe(realm, "mcl-ts/tests/exit_heard_v1", () => {});
if (process.env.MODE === "stop") await sub.stop();
else await pool.close();
process.exit(0);
