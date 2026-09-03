# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-09-03

Replaced koffi (a generic FFI bridge) with a purpose-built native addon,
so the package genuinely needs zero install-time scripts -- the gap the
previous release deferred.

### Changed

- `cabi/` now builds with `go build -buildmode=c-archive` (producing
  `libmacula.a` + `libmacula.h`) instead of `-buildmode=c-shared`. No
  changes to `cabi/main.go` itself -- only the build mode.
- `addon/binding.cc`: a new, purpose-built N-API addon
  ([node-addon-api](https://github.com/nodejs/node-addon-api)) wrapping
  exactly macula-ts's own exported functions -- not a generic FFI bridge.
  Links `libmacula.a` in statically, so the resulting `.node` file is
  self-contained (no separate `.so` to locate at runtime). Also fixes a
  latent bug the koffi-era binding.ts's own doc comment admitted to: the
  `errOut` C string from a failed call is now actually freed via
  `macula_free_string` instead of leaked.
- `src/binding.ts`: loads the addon via
  [`node-gyp-build`](https://github.com/prebuild/node-gyp-build) instead
  of koffi's runtime signature declarations. `identity.ts`'s public API
  is unchanged.
- Packaged with [`prebuildify`](https://github.com/prebuild/prebuildify):
  the compiled `linux-x64` `.node` binary is committed under `prebuilds/`
  and shipped as part of the npm package. `package.json` has no
  `install`/`postinstall`/`preinstall` script.

### Removed

- `koffi` dependency entirely.

### Verified

- A real packed tarball (`npm pack`) installed into a directory with no
  source tree present: completed in well under a second, zero compiler
  invocation, zero network fetch of a prebuilt binary -- the addon loads
  purely from the bundled `prebuilds/` directory. CI's last step now
  re-runs this exact check on every push.
- 500-iteration generate/read/free loop, a deliberate double-free, and a
  garbage/never-issued handle -- none crash the process (the
  `recover()`-guarded handle lookups from 0.1.0 hold under the new
  binding too); all produce unique NodeIDs; the seed round-trip still
  matches.

### Known gaps (deferred, not forgotten)

- Only `linux-x64` is covered. No cross-platform prebuilt matrix
  (`darwin`/`win32`, `arm64`) yet.
- Everything past identity: transport/handshake, RPC, pubsub, DHT, content
  transfer, streaming, UCAN.

## [0.1.0] - 2026-09-03

Initial walking skeleton. FFI binding over macula-go's C-shared build
(`cabi/`, loaded via [koffi](https://koffi.dev)), proving the FFI plumbing
works end-to-end with one real operation.

### Added

- `cabi/`: a Go module (`go build -buildmode=c-shared`) exporting
  `macula_identity_generate`, `macula_identity_from_seed_bytes`,
  `macula_identity_node_id`, `macula_identity_private_bytes`,
  `macula_identity_free`, `macula_free_string` — mirroring macula-php's
  `cabi/` handle-based memory-ownership convention.
- `Identity.generate()` / `Identity.fromSeedBytes()` / `#nodeId` /
  `#privateSeedBytes` / `#dispose()` — a real TypeScript wrapper over
  macula-go's `identity.Generate()`, not a stub. Verified by asserting the
  S/Kademlia puzzle property (>=8 leading zero bits on SHA-256(NodeID)) on
  the returned identity, a property no stub could satisfy.
- CI (`ubuntu-latest` only): build `cabi/`, `npm test`, `npm run typecheck`.

### Fixed

- `cgo.Handle.Value()`/`.Delete()` panic (not error) on an invalid or
  already-freed handle. An arbitrary `uintptr_t` from the TypeScript side
  took the whole process down before this was caught during development
  and fixed with `recover()`-guarded lookup helpers
  (`identityFromHandle`/`deleteHandle` in `cabi/main.go`).

### Known gaps (deferred, not forgotten)

- `koffi` carries its own native install script and ships no prebuilt
  binaries in its npm tarball — the same class of postinstall friction
  `macula-mcp` retired by moving off `better-sqlite3`. No better
  alternative exists today; proper packaging (likely a dedicated
  N-API/napi-rs addon with per-platform `optionalDependencies`) is future
  work. See README.md.
- `cabi/` builds for Linux only; no cross-platform prebuilt matrix yet.
- Everything past identity: transport/handshake, RPC, pubsub, DHT, content
  transfer, streaming, UCAN.
