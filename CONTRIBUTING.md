# Contributing to macula-ts

## Setup

```bash
npm install
```

This also builds `cabi/`'s Go C-shared library (via the `prepare` script) so
`npm test` works right after a fresh clone. Requires Go >=1.27 and Node
>=24.18.1 — see `.tool-versions` if you use asdf.

## Build, typecheck, test

```bash
npm run typecheck   # tsc --noEmit
npm run build        # build:native + tsc
npm test             # vitest run
```

All three run in CI (`.github/workflows/ci.yml`) on `ubuntu-latest` only —
there is no cross-platform build matrix yet (see README.md's "Known
packaging gap"). If you're changing anything under `cabi/`, rebuild it
yourself first with `npm run build:native` before running the TS test
suite, since vitest does not trigger a native rebuild on its own.

## Working across the FFI boundary

`cabi/main.go` is the only place that touches macula-go directly; everything
else in this repo consumes it through `src/binding.ts`. If you add a new
exported `//export` function:

- Resolve any `identityHandle` (or future handle types) through a
  `recover()`-guarded helper like `identityFromHandle`, never through
  `cgo.Handle(h).Value()` directly — see the "Memory ownership" section of
  README.md for why this is not optional (`.Value()` and `.Delete()` panic,
  not error, on an invalid handle).
- Verify the exact koffi call shape empirically (run it against the real
  compiled library) before trusting it — koffi's inline `_Out_`/`_Inout_`
  string syntax and its `koffi.out(koffi.pointer(x, 2))` array-signature
  form aren't interchangeable for every parameter shape, and getting this
  wrong fails silently or crashes rather than throwing a clear TypeScript
  error.
- Add a test that asserts something the FFI call could only produce by
  actually reaching macula-go — not just "the call didn't throw". See
  `src/identity.test.ts`'s puzzle-difficulty assertion.

## License

Apache-2.0, matching every other macula-io SDK.
