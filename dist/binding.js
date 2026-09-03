// Loads the compiled N-API addon (addon/binding.cc) and re-exports its
// typed functions. Unlike the koffi-era version of this file, there is
// no runtime signature declaration here -- the addon's C++ glue already
// knows its own shapes, throws real JS errors on failure (no more
// manual errOut-array/checkErr dance), and is a single self-contained
// .node file (cabi/'s Go code is statically linked in via
// -buildmode=c-archive, not loaded separately at runtime).
//
// node-gyp-build picks, at require time, whichever of these exists:
// build/Release/*.node (a local dev build via `npm run build:addon:dev`)
// or prebuilds/<platform>-<arch>/*.node (baked in by `npm run
// build:prebuilds` / prebuildify, and published as part of the npm
// package) -- this is the whole point: a consumer installing this
// package from npm never runs a compiler or fetches anything, because
// the matching prebuild is already sitting in the downloaded tarball.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const addon = require("node-gyp-build")(repoRoot);
export const native = {
    identityGenerate() {
        return addon.identityGenerate();
    },
    identityFromSeedBytes(seed32) {
        if (seed32.length !== 32) {
            throw new Error(`macula-ts: seed must be exactly 32 bytes, got ${seed32.length}`);
        }
        return addon.identityFromSeedBytes(seed32);
    },
    identityNodeId(handle) {
        return addon.identityNodeId(handle);
    },
    identityPrivateBytes(handle) {
        return addon.identityPrivateBytes(handle);
    },
    identityFree(handle) {
        addon.identityFree(handle);
    },
};
//# sourceMappingURL=binding.js.map