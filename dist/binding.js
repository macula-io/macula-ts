// Loads the compiled N-API addon (addon/binding.cc) and types its functions.
// macula-go's shared C ABI (cabi/, built as a c-archive from the release in
// native/MACULA_GO) is linked into the addon statically, so it is one
// self-contained .node file. node-gyp-build picks, at require time, a local
// build (build/Release/*.node) or the published prebuild for this platform
// (prebuilds/<platform>-<arch>/*.node), so a consumer installing from npm
// never runs a compiler.
//
// Every function is wrapped once here: an error the ABI reports (JSON with a
// fixed kind) reaches the rest of the package as the class its kind names
// (wire.ts nativeError).
//
// Internal to the package: the public API is key.ts, pool.ts and stream.ts.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";
import { nativeError } from "./wire.js";
const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The addon for this platform, or an error that says what failed to load. */
function load() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require("node-gyp-build")(repoRoot);
    }
    catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        throw new Error(`macula-ts: the native addon did not load on ${process.platform}-${process.arch}: ${why}.${windowsHint()}`);
    }
}
// On Windows the addon needs macula-go's DLL (macula-<release>.dll) beside
// its .node: say whether it is there, so a missing DLL is told apart from a
// failure of anything else.
function windowsHint() {
    if (process.platform !== "win32")
        return "";
    let dir;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        dir = dirname(require("node-gyp-build").path(repoRoot));
    }
    catch {
        return " No prebuild for this platform was found.";
    }
    const dlls = readdirSync(dir).filter((f) => /^macula-v[0-9.]+\.dll$/.test(f));
    return dlls.length === 0
        ? ` macula-go's DLL (macula-<release>.dll) is not there, beside the .node in ${dir}.`
        : ` ${dlls.join(", ")} is there, beside the .node, so the failure is elsewhere.`;
}
const addon = load();
/** fn with the ABI's errors as their classes: a rejection or a throw. */
function typed(fn) {
    return ((...args) => {
        let out;
        try {
            out = fn(...args);
        }
        catch (e) {
            throw nativeError(e);
        }
        return out instanceof Promise ? out.catch((e) => { throw nativeError(e); }) : out;
    });
}
export const native = Object.fromEntries(Object.entries(addon).map(([name, value]) => [name, typeof value === "function" ? typed(value) : value]));
//# sourceMappingURL=binding.js.map