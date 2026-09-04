# Examples

Real, runnable scripts against the real production fleet
(`station-de-frankfurt.macula.io`) — no mocks. Numbered per primitive,
matching the convention macula-php's `examples/` already established for
this SDK's own structural precedent.

Build the package first, then run any example directly with Node (24.18+,
native TypeScript support — no compile step needed for the examples
themselves):

```bash
npm run build
node examples/01_quickstart.ts
node examples/02_call.ts
node examples/03_publish_subscribe.ts
node examples/04_content.ts
node examples/05_direct_dial.ts
node examples/06_ucan.ts
```

| File | Covers |
|---|---|
| [01_quickstart.ts](01_quickstart.ts) | `Identity.generate()`, `Session.connect()`, `session.close()` |
| [02_call.ts](02_call.ts) | `session.serve()` (provider) + `session.call()` (caller), two Sessions in one process |
| [03_publish_subscribe.ts](03_publish_subscribe.ts) | `session.subscribe()` + `session.publish()`, self-delivery |
| [04_content.ts](04_content.ts) | `session.putContent()` / `session.getContent()` |
| [05_direct_dial.ts](05_direct_dial.ts) | `session.advertiseDirect()` + `session.resolveDirect()` + `session.callDirect()` |
| [06_ucan.ts](06_ucan.ts) | `Ucan.mint()` + `session.callWithUcan()` |

Not covered yet — not implemented in this SDK (see the main
[README](../README.md#whats-explicitly-not-yet-implemented)): streaming
RPC, streaming/content direct-dial, cert-chain-authorized direct-dial,
provider-side UCAN policy gating.
