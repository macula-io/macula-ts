# Contributing to macula-ts

## Setup

```bash
npm run build:go   # builds native/build from macula-go at native/MACULA_GO -- must come first
npm install        # builds the native addon (node-gyp, triggered
                   # implicitly by binding.gyp's presence) + JS deps
```

`npm run build:go` has to run *before* `npm install`: this repo's
`binding.gyp` (not part of the published package, see README.md's
"Packaging" section) makes npm implicitly run `node-gyp rebuild` as part
of install, and that rebuild links against macula-go's archive, so it has
to exist already. Requires Go >=1.27, a C and a C++ toolchain, and Node
>=24.18.1; see `.tool-versions` if you use asdf or mise.

## Build, typecheck, test

```bash
npm run typecheck        # tsc --noEmit
npm run build            # build:addon:dev + tsc
npm test                 # native/build, then vitest run
npm run build:prebuilds  # this platform's prebuild, into prebuilds/ (never committed)
```

CI (`.github/workflows/ci.yml`) builds and tests on linux-x64, builds every
platform's prebuild from source (`prebuild-matrix.yml`), and installs the
packed package into an empty project to check it compiles nothing. After a
change under `addon/`, rebuild with `npm run build:addon:dev` before running
the TypeScript suite (vitest does not rebuild the addon). `dist/` is
committed: run `npm run build:ts` and commit the result, which CI checks.

## Moving to a new macula-go release

This repository has no Go code: the addon binds macula-go's shared C ABI
(`cabi/macula.h`, contract in `cabi/CONTRACT.md`). To take a new release, put
its tag and commit in `native/MACULA_GO`; `scripts/build-native.sh` refuses a
tag that is not that commit. The addon checks `macula_abi_version()` when it
loads and is compiled against `MACULA_ABI_VERSION`; a new function does not
change the version, a changed declaration does.

## Working across the C ABI

- Add the N-API wrapper in `addon/binding.cc` and register it in `Init()`;
  type it in `src/binding.ts`, whose wrapper turns the ABI's error JSON into
  the matching TypeScript error.
- A call that does network I/O runs on a worker (`Queue`); a quick one (a
  verification, a message) may run on the calling thread.
- Probe the failure modes deliberately (an invalid handle, a freed one, a
  wrong-length buffer) before calling a function done.
- Add a test that asserts something only a real call through macula-go could
  produce, not just "the call did not throw".

## License

Apache-2.0, matching every other macula-io SDK.
