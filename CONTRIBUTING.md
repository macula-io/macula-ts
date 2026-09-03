# Contributing to macula-ts

## Setup

```bash
npm run build:go   # builds cabi/build/libmacula.a -- must come first
npm install          # builds the native addon (node-gyp, triggered
                      # implicitly by binding.gyp's presence) + JS deps
```

`npm run build:go` has to run *before* `npm install`: this repo's
`binding.gyp` (not part of the published package -- see README.md's
"Packaging" section) makes npm implicitly run `node-gyp rebuild` as part
of install, and that rebuild links against the Go archive, so it has to
already exist. Requires Go >=1.27, a C++ toolchain, and Node >=24.18.1 —
see `.tool-versions` if you use asdf.

## Build, typecheck, test

```bash
npm run typecheck        # tsc --noEmit
npm run build             # build:addon:dev + tsc
npm test                  # vitest run
npm run build:prebuilds   # regenerate prebuilds/ -- commit the result
```

All of this runs in CI (`.github/workflows/ci.yml`) on `ubuntu-latest`
only — there is no cross-platform build matrix yet (see README.md's
"Packaging" section). If you change anything under `addon/` or `cabi/`,
rebuild with `npm run build:addon:dev` before running the TS test suite
(vitest does not trigger a native rebuild on its own), and regenerate +
commit `prebuilds/` with `npm run build:prebuilds` before pushing — CI's
last step fails the build if the committed prebuild doesn't match a fresh
one.

## Working across the FFI boundary

`cabi/main.go` is the only place that touches macula-go directly; everything
else in this repo consumes it through `src/binding.ts`. If you add a new
exported `//export` function:

- Resolve any `identityHandle` (or future handle types) through a
  `recover()`-guarded helper like `identityFromHandle`, never through
  `cgo.Handle(h).Value()` directly — see the "Memory ownership" section of
  README.md for why this is not optional (`.Value()` and `.Delete()` panic,
  not error, on an invalid handle).
- Add the matching N-API wrapper in `addon/binding.cc` and register it in
  `Init()`. Verify the exact call shape empirically (run it, don't just
  read the code) before trusting it — a mismatched buffer size or handle
  width fails silently or crashes rather than throwing a clear TypeScript
  error.
- Probe the new function's failure modes deliberately (an invalid handle,
  a double-free, a wrong-length buffer) before considering it done — see
  0.2.0's CHANGELOG entry for why: this exact discipline is what caught
  the `errOut`-leak and the handle-panic bugs, neither of which showed up
  on the happy path alone.
- Add a test that asserts something the FFI call could only produce by
  actually reaching macula-go — not just "the call didn't throw". See
  `src/identity.test.ts`'s puzzle-difficulty assertion.

## License

Apache-2.0, matching every other macula-io SDK.
