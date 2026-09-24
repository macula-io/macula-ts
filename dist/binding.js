// Loads the compiled N-API addon (addon/binding.cc) and types its functions.
// cabi/'s Go code is linked into the addon statically, so it is one
// self-contained .node file. node-gyp-build picks, at require time, a local
// build (build/Release/*.node) or the published prebuild for this platform
// (prebuilds/<platform>-<arch>/*.node), so a consumer installing from npm
// never runs a compiler.
//
// Internal to the package: the public API is key.ts, pool.ts and stream.ts.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const native = require("node-gyp-build")(repoRoot);
//# sourceMappingURL=binding.js.map