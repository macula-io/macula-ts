# Examples

Runnable scripts against a real macula 12 station. Build the package first,
then run an example with Node (24.18+, native TypeScript: no compile step for
the examples). Each reads where to connect from the environment, through
[`mesh.ts`](mesh.ts):

```bash
export MACULA_SEED='[2600:3c0e::2000:c2ff:fed0:f20b]:4433'   # the station, host:port
export MACULA_STATION_ID=<its node_id, 64 hex>              # it must prove it
export MACULA_REALM=<realm id, 64 hex>
export MACULA_REALM_KEY=<the realm's key as carried, hex>   # the realm publishes it
npm run build
node examples/01_quickstart.ts
```

The node's key is created in `node.key` on first use (or `MACULA_KEY`),
readable by its owner only.

| File | Covers | Needs |
|---|---|---|
| [01_quickstart.ts](01_quickstart.ts) | `NodeKey.loadOrCreate`, `Pool.connect`, `providers`, `call` by direct dial | nothing more |
| [02_serve.ts](02_serve.ts) | `serve`, `Served.stop` | an org the realm admitted, delegated to this node |
| [03_publish_subscribe.ts](03_publish_subscribe.ts) | `subscribe`, `publish`, `Subscription.stop` | nothing more |
| [04_stream.ts](04_stream.ts) | `serveStream`, `openStream`, reading a stream | as 02 |
